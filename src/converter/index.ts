// Entry point of the lazily loaded converter bundle (dist/converter/index.mjs).
// It has no dependency on the `vscode` module: the host passes in everything it needs.
import { addHighlightAnnotations, paintPageBackground, type AnnotationInput } from '../export/annotate';
import { BrowserManager } from './chromium';
import { prepareHighlighter } from './highlight';
import { parseMarkdown, renderParsed } from './markdown';
import { MermaidRenderer, injectMermaid } from './mermaid';
import { buildDocumentHtml, printPdf } from './pdf';
import type { ConverterOptions, RenderRequest, RenderResult, ResolvedBrowser } from './types';
import { documentUrl } from './urls';

export * from './types';
export type { AnnotationInput };

/** Page color of the dark theme; must match `--bg` in print.css. */
const DARK_PAGE_BACKGROUND = '#0d1117';

export class Converter {
  private readonly browsers: BrowserManager;
  private readonly mermaid: MermaidRenderer;

  constructor(private readonly options: ConverterOptions) {
    this.browsers = new BrowserManager(options.storageDir, options.log);
    this.mermaid = new MermaidRenderer(options.assetsDir, options.log);
  }

  async render(request: RenderRequest): Promise<RenderResult> {
    const timings: Record<string, number> = {};
    let mark = performance.now();
    const lap = (name: string) => {
      const now = performance.now();
      timings[name] = Math.round(now - mark);
      mark = now;
    };

    const warnings: string[] = [];
    const urlContext = { docPath: request.docPath, workspaceRootPath: request.workspaceRootPath };
    const parsed = parseMarkdown(request.markdown, urlContext);
    const highlighter = await prepareHighlighter(parsed.languages, (w) => warnings.push(w));
    let body = renderParsed(parsed, highlighter);
    lap('markdown');

    const lease = await this.browsers.acquire(request.chromiumPath);
    lap('browser');
    try {
      const diagrams = parsed.env.mermaid;
      if (diagrams.length > 0) {
        const results = await this.mermaid.render(lease.browser, diagrams, request.theme);
        body = injectMermaid(body, results, warnings);
        lap('mermaid');
      }
      const title = parsed.title ?? request.fileName;
      const html = buildDocumentHtml({ body, title, theme: request.theme, pageSize: request.pageSize });
      const printed = await printPdf(lease.browser, {
        html,
        documentUrl: documentUrl(request.docPath),
        docPath: request.docPath,
        pageSize: request.pageSize,
        pageNumbers: request.pageNumbers,
        theme: request.theme,
        allowRemoteImages: request.allowRemoteImages,
        assetsDir: this.options.assetsDir,
        readResource: request.readResource,
        log: this.options.log,
      });
      warnings.push(...printed.warnings);
      lap('print');
      let pdf = printed.pdf;
      if (request.theme === 'dark') {
        pdf = await paintPageBackground(pdf, DARK_PAGE_BACKGROUND);
        lap('background');
      }
      return {
        pdf,
        warnings,
        title,
        browser: this.browsers.current?.executablePath ?? 'unknown',
        timings,
      };
    } finally {
      lease.release();
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

export async function annotatePdf(pdf: Uint8Array, highlights: AnnotationInput[]): Promise<Uint8Array> {
  return addHighlightAnnotations(pdf, highlights);
}
