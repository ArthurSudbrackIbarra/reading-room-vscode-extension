// Mermaid needs a real DOM to lay out diagrams, so it runs in its own browser page:
// scripts on, no network (only mermaid.min.js is served), `securityLevel: 'strict'`.
// The resulting SVGs are inlined into the print page, which runs with JavaScript off.
import { createHash } from 'node:crypto';
import type { Browser } from 'puppeteer-core';
import type { PageTheme } from '../shared/types';
import { createRequestHandler } from './assets';
import { escapeHtml } from './highlight';
import type { Logger } from './types';
import { ORIGIN } from './urls';

export interface MermaidResult {
  svg?: string;
  error?: string;
}

const SANDBOX_PATH = '/__mermaid__.html';
const SANDBOX_HTML = `<!doctype html><html><head><meta charset="utf-8">
<script src="/__ext__/mermaid/mermaid.min.js"></script></head><body></body></html>`;
const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const MAX_CACHE = 200;

export class MermaidRenderer {
  private readonly cache = new Map<string, MermaidResult>();

  constructor(
    private readonly assetsDir: string,
    private readonly log: Logger,
  ) {}

  async render(browser: Browser, sources: string[], theme: PageTheme): Promise<MermaidResult[]> {
    const keys = sources.map((src) => createHash('sha256').update(theme).update('\0').update(src).digest('hex').slice(0, 16));
    const results: (MermaidResult | undefined)[] = keys.map((k) => this.cache.get(k));
    const missing = keys.map((key, i) => ({ key, i, src: sources[i] })).filter(({ i }) => !results[i]);
    if (missing.length > 0) {
      const rendered = await this.renderInSandbox(
        browser,
        missing.map((m) => ({ id: `mermaid-${m.key}`, src: m.src })),
        theme,
      );
      missing.forEach((m, n) => {
        results[m.i] = rendered[n];
        this.cache.set(m.key, rendered[n]);
      });
      while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    }
    return results as MermaidResult[];
  }

  private async renderInSandbox(browser: Browser, items: { id: string; src: string }[], theme: PageTheme): Promise<MermaidResult[]> {
    const t0 = performance.now();
    const page = await browser.newPage();
    const warnings: string[] = [];
    const lap = (label: string) => this.log.debug?.(`Mermaid ${label}: ${Math.round(performance.now() - t0)} ms`);
    lap('page created');
    try {
      page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
      await page.setRequestInterception(true);
      page.on(
        'request',
        createRequestHandler({
          pages: new Map([[SANDBOX_PATH, SANDBOX_HTML]]),
          assetsDir: this.assetsDir,
          allowRemoteImages: false,
          warnings,
          log: this.log,
        }),
      );
      await page.setViewport({ width: 1000, height: 800 });
      await page.goto(ORIGIN + SANDBOX_PATH, { waitUntil: 'load', timeout: 30_000 });
      lap('sandbox loaded');
      const rendered = await page.evaluate(
        async (diagrams, mermaidTheme, fontFamily) => {
          type MermaidApi = {
            initialize(config: Record<string, unknown>): void;
            render(id: string, text: string): Promise<{ svg: string }>;
          };
          const mermaid = (window as unknown as { mermaid?: MermaidApi }).mermaid;
          if (!mermaid) return diagrams.map(() => ({ error: 'Mermaid failed to load.' }));
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: mermaidTheme,
            fontFamily,
            themeVariables: { fontFamily },
            flowchart: { htmlLabels: true },
          });
          const out: { svg?: string; error?: string }[] = [];
          for (const { id, src } of diagrams) {
            try {
              const { svg } = await mermaid.render(id, src);
              out.push({ svg });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              out.push({ error: message });
              document.getElementById(`d${id}`)?.remove();
              document.getElementById(id)?.remove();
            }
          }
          return out;
        },
        items,
        theme === 'dark' ? 'dark' : 'default',
        FONT_FAMILY,
      );
      lap(`${items.length} diagram(s) rendered`);
      return rendered;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Mermaid rendering failed: ${message}`);
      return items.map(() => ({ error: `Mermaid could not run: ${message}` }));
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

/** Replaces the placeholders left by the fence renderer with SVGs (or error boxes). */
export function injectMermaid(html: string, results: MermaidResult[], warnings: string[]): string {
  return html.replace(/<div class="mermaid-slot" data-i="(\d+)"><\/div>/g, (_match, index: string) => {
    const n = Number(index);
    const result = results[n];
    if (result?.svg) return `<figure class="mermaid-figure">${result.svg}</figure>`;
    const message = result?.error ?? 'Unknown error';
    warnings.push(`Mermaid diagram #${n + 1} could not be rendered: ${message.split('\n')[0]}`);
    return `<div class="mermaid-error"><strong>Mermaid diagram could not be rendered</strong><pre>${escapeHtml(message)}</pre></div>`;
  });
}
