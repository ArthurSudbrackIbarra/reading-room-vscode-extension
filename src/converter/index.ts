// Entry point of the lazily loaded converter bundle (dist/converter/index.mjs).
// It has no dependency on the `vscode` module: the host passes in everything it needs.
import { annotate, paintPageBackground, type AnnotatedPdf, type AnnotationInput, type ExportAnnotations } from '../export/annotate';
import { batchPlan, lineWeights } from './batches';
import { BrowserManager, type Lease } from './chromium';
import { prepareHighlighter } from './highlight';
import { languagesBefore, parseMarkdown, renderParsed, topLevelBlocks } from './markdown';
import { MermaidRenderer, injectMermaid } from './mermaid';
import { buildDocumentHtml, printPdf } from './pdf';
import { normalizeText, plainTextToHtml } from './text';
import type { ConverterOptions, RenderRequest, RenderResult, ResolvedBrowser } from './types';
import { documentUrl } from './urls';

export * from './types';
export type { AnnotatedPdf, AnnotationInput, ExportAnnotations };

/** Page color of the dark theme; must match `--bg` in print.css. */
const DARK_PAGE_BACKGROUND = '#0d1117';
/** How long the whole document waits for the first part of a long one to be out before its own HTML is made. */
const FIRST_BATCH_WAIT_MS = 1500;

/** A document that was read, ready to become HTML: all of it, or its first blocks (a batch, see batches.ts). */
interface Source {
  title: string;
  bodyClass: 'markdown-body' | 'text-body';
  /** For each batch, how many blocks it holds, counted from the top; empty when the document is converted in one go. */
  plan: number[];
  /** How much of the document its first `blocks` blocks are (0 to 1). */
  fraction(blocks: number): number;
  /** The HTML of the first `blocks` blocks (of all of them when undefined), and the Mermaid diagrams still to be drawn in it. */
  html(blocks: number | undefined, warn: (message: string) => void): Promise<{ body: string; diagrams: string[] }>;
}

const sum = (values: readonly number[], count = values.length): number => {
  let total = 0;
  for (let i = 0; i < count && i < values.length; i++) total += values[i];
  return total;
};

function markdownSource(request: RenderRequest): Source {
  const parsed = parseMarkdown(request.markdown, { docPath: request.docPath, workspaceRootPath: request.workspaceRootPath });
  const blocks = topLevelBlocks(parsed);
  const weights = blocks.map((block) => block.weight);
  const total = sum(weights) || 1;
  return {
    title: parsed.title ?? request.fileName,
    bodyClass: 'markdown-body',
    plan: batchPlan(weights),
    fraction: (count) => sum(weights, count) / total,
    async html(count, warn) {
      const end = count === undefined ? parsed.tokens.length : (blocks[count - 1]?.end ?? parsed.tokens.length);
      // A first part needs the grammars of its own code blocks only: it does not wait for the others.
      const highlighter = await prepareHighlighter(count === undefined ? parsed.languages : languagesBefore(parsed, end), warn);
      const body = renderParsed(parsed, highlighter, end);
      return { body, diagrams: parsed.env.mermaid };
    },
  };
}

function textSource(request: RenderRequest): Source {
  const text = normalizeText(request.markdown);
  const lines = text.split('\n');
  const weights = lineWeights(lines);
  const total = sum(weights) || 1;
  return {
    title: request.fileName,
    bodyClass: 'text-body',
    plan: batchPlan(weights),
    fraction: (count) => sum(weights, count) / total,
    html: (count) => Promise.resolve({ body: plainTextToHtml(count === undefined ? text : lines.slice(0, count).join('\n')), diagrams: [] }),
  };
}

export class Converter {
  private readonly browsers: BrowserManager;
  private readonly mermaid: MermaidRenderer;

  constructor(private readonly options: ConverterOptions) {
    this.browsers = new BrowserManager(options.storageDir, options.log);
    this.mermaid = new MermaidRenderer(options.assetsDir, options.log);
  }

  async render(request: RenderRequest): Promise<RenderResult> {
    const started = performance.now();
    const since = (from: number) => Math.round(performance.now() - from);
    const timings: Record<string, number> = {};
    const warnings: string[] = [];
    // The browser starts while the document is read: neither waits for the other.
    const leasing = this.browsers.acquire(request.chromiumPath);
    leasing.catch(() => undefined);
    let lease: Lease | undefined;
    /** Set when the whole document is done (or failed): a batch that is still being made is dropped. */
    let settled = false;
    try {
      const source = request.kind === 'text' ? textSource(request) : markdownSource(request);
      const read = since(started);
      const acquired = await leasing;
      lease = acquired;
      timings.browser = Math.max(0, since(started) - read);

      /** HTML → PDF: draws the diagrams, prints, and gives dark pages their color. */
      const print = async (part: { body: string; diagrams: string[] }, whole: boolean, problems: string[], times?: Record<string, number>) => {
        let mark = performance.now();
        const lap = (name: string) => {
          if (times) times[name] = since(mark);
          mark = performance.now();
        };
        let body = part.body;
        if (part.diagrams.length > 0) {
          body = injectMermaid(body, await this.mermaid.render(acquired.browser, part.diagrams, request.theme), problems);
          lap('mermaid');
        }
        const printed = await printPdf(acquired.browser, {
          html: buildDocumentHtml({ body, title: source.title, theme: request.theme, pageSize: request.pageSize, bodyClass: source.bodyClass }),
          documentUrl: documentUrl(request.docPath),
          docPath: request.docPath,
          pageSize: request.pageSize,
          pageNumbers: request.pageNumbers,
          pageTotal: whole,
          theme: request.theme,
          allowRemoteImages: request.allowRemoteImages,
          assetsDir: this.options.assetsDir,
          readResource: request.readResource,
          log: this.options.log,
        });
        problems.push(...printed.warnings);
        lap('print');
        let pdf = printed.pdf;
        if (request.theme === 'dark') {
          pdf = await paintPageBackground(pdf, DARK_PAGE_BACKGROUND);
          lap('background');
        }
        return { pdf, remoteFailures: printed.remoteFailures };
      };

      // A long document: its first part, then larger parts, each as soon as it is a PDF. What a
      // part warns about, the whole document warns about too, so only the latter is reported.
      const onPartial = request.onPartial;
      let firstOut: () => void = () => undefined;
      const firstBatch = new Promise<void>((resolve) => (firstOut = resolve));
      void (async () => {
        for (const blocks of onPartial ? source.plan : []) {
          if (settled) return;
          const part = await source.html(blocks, () => undefined);
          const { pdf } = await print(part, false, []);
          if (settled) return;
          const ms = since(started);
          timings.firstPart ??= ms;
          try {
            onPartial?.({ pdf, fraction: source.fraction(blocks), ms });
          } finally {
            firstOut();
          }
        }
      })()
        .catch((err: unknown) =>
          this.options.log.warn(`A first part of the document could not be converted ahead of the rest: ${err instanceof Error ? err.message : String(err)}`),
        )
        .finally(firstOut);

      // The whole document, alongside. Its HTML is made once the first part is out (making it
      // keeps this thread busy, and the first part should not wait behind that), or after a
      // moment if that part is slow to come.
      await Promise.race([firstBatch, new Promise((resolve) => setTimeout(resolve, FIRST_BATCH_WAIT_MS))]);
      const htmlStarted = performance.now();
      const whole = await source.html(undefined, (w) => warnings.push(w));
      timings[request.kind === 'text' ? 'text' : 'markdown'] = read + since(htmlStarted);
      const times: Record<string, number> = {};
      const printed = await print(whole, true, warnings, times);
      settled = true;
      return {
        pdf: printed.pdf,
        warnings,
        title: source.title,
        browser: this.browsers.current?.executablePath ?? 'unknown',
        timings: orderedTimings(timings, times),
        remoteFailures: printed.remoteFailures,
      };
    } finally {
      settled = true;
      if (lease) lease.release();
      else void leasing.then((late) => late.release()).catch(() => undefined);
    }
  }

  /** Lists the browsers that would be tried, in order. */
  candidates(configuredPath?: string): Promise<ResolvedBrowser[]> {
    return this.browsers.candidates(configuredPath);
  }

  downloadBrowser(onProgress: (downloaded: number, total: number) => void): Promise<ResolvedBrowser> {
    return this.browsers.download(onProgress);
  }

  dispose(): Promise<void> {
    return this.browsers.dispose();
  }
}

/** The steps in the order they are logged: reading the document, the browser, the first part (if any), then the whole document. */
function orderedTimings(timings: Record<string, number>, whole: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of ['text', 'markdown', 'browser', 'firstPart']) if (timings[name] !== undefined) out[name] = timings[name];
  return { ...out, ...whole };
}

export async function annotatePdf(pdf: Uint8Array, annotations: ExportAnnotations, password?: string): Promise<AnnotatedPdf> {
  return annotate(pdf, annotations, password);
}
