// HTML → PDF with Chromium's print-to-PDF, entirely in memory.
import type { Browser, PaperFormat } from 'puppeteer-core';
import { PAGE_MARGINS_MM, type PageSize, type PageTheme } from '../shared/types';
import { createRequestHandler } from './assets';
import { escapeHtml } from './highlight';
import type { Logger } from './types';
import { DOC_SUFFIX, FS_PREFIX, ORIGIN, extUrl } from './urls';

const PAGE_MM: Record<PageSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  Letter: { width: 215.9, height: 279.4 },
};
const MM_TO_CSS_PX = 96 / 25.4;

export function contentBox(pageSize: PageSize): { widthPx: number; heightMm: number } {
  const page = PAGE_MM[pageSize];
  return {
    widthPx: (page.width - PAGE_MARGINS_MM.left - PAGE_MARGINS_MM.right) * MM_TO_CSS_PX,
    heightMm: page.height - PAGE_MARGINS_MM.top - PAGE_MARGINS_MM.bottom,
  };
}

export function buildDocumentHtml(options: {
  body: string;
  title: string;
  theme: PageTheme;
  pageSize: PageSize;
  /** `markdown-body` (default) or `text-body` for plain text documents. */
  bodyClass?: string;
}): string {
  const { heightMm } = contentBox(options.pageSize);
  return `<!doctype html>
<html lang="en" class="theme-${options.theme}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.title)}</title>
<link rel="stylesheet" href="${extUrl('katex/katex.min.css')}">
<link rel="stylesheet" href="${extUrl('print.css')}">
<style>:root { --content-height: ${heightMm.toFixed(1)}mm; }</style>
</head>
<body>
<main class="${options.bodyClass ?? 'markdown-body'}">
${options.body}
</main>
</body>
</html>`;
}

export interface PrintOptions {
  html: string;
  /** URL the document is served at (see urls.ts `documentUrl`). */
  documentUrl: string;
  /** URI path of the Markdown file; links to it become same-document links. */
  docPath: string;
  pageSize: PageSize;
  pageNumbers: boolean;
  theme: PageTheme;
  allowRemoteImages: boolean;
  assetsDir: string;
  readResource(uriPath: string): Promise<Uint8Array>;
  log: Logger;
}

interface FixupResult {
  warnings: string[];
  tables: number;
  keptBlocks: number;
}

/** Runs inside the print page (scripts are disabled there, but `page.evaluate` still works). */
async function fixupDocument(args: { origin: string; fsPrefix: string; docPath: string }): Promise<FixupResult> {
  const warnings: string[] = [];
  await document.fonts.ready;

  // 1. Links: local targets become file:/// URLs (so they keep working in other PDF readers);
  //    links back to this same Markdown file become in-document anchors.
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const raw = a.getAttribute('href') ?? '';
    if (raw.startsWith('#')) continue;
    let url: URL;
    try {
      url = new URL(a.href);
    } catch {
      continue;
    }
    if (url.origin !== args.origin) continue;
    if (url.pathname.startsWith(args.fsPrefix + '/')) {
      const path = url.pathname
        .slice(args.fsPrefix.length)
        .split('/')
        .map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        })
        .join('/');
      if (path.toLowerCase() === args.docPath.toLowerCase()) {
        a.setAttribute('href', url.hash || '#');
        continue;
      }
      a.setAttribute('href', `file://${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}${url.search}${url.hash}`);
    } else {
      a.removeAttribute('href');
    }
  }

  // 2. Images that failed to load become a visible placeholder instead of a broken-image icon.
  for (const img of Array.from(document.images)) {
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) {
      const label = img.getAttribute('alt') || img.getAttribute('src') || '';
      const placeholder = document.createElement('span');
      placeholder.className = 'missing-image';
      placeholder.textContent = `Image not available: ${label}`;
      img.replaceWith(placeholder);
    }
  }

  // 3. Keep short code blocks and tables on one page.
  let keptBlocks = 0;
  for (const block of Array.from(document.querySelectorAll<HTMLElement>('.code-block, pre:not(.code-block pre)'))) {
    if (block.getBoundingClientRect().height < 300) {
      block.classList.add('keep');
      keptBlocks++;
    }
  }
  for (const table of Array.from(document.querySelectorAll<HTMLTableElement>('table'))) {
    if (table.getBoundingClientRect().height < 320) {
      table.classList.add('keep');
      keptBlocks++;
    }
  }

  // 4. A paragraph that introduces the next block ("…looks like this:") stays on its page.
  const isFigureLike = (el: Element | null): boolean => {
    if (!el) return false;
    if (el.matches('.code-block, table, figure, .mermaid-figure, .mermaid-error, .katex-block, .katex-display, pre, ul, ol')) return true;
    if (el.matches('p')) {
      const children = Array.from(el.children);
      return children.length > 0 && children.every((c) => c.matches('img, br, a:has(> img), .missing-image')) && (el.textContent ?? '').trim() === '';
    }
    return false;
  };
  for (const p of Array.from(document.querySelectorAll<HTMLParagraphElement>('.markdown-body p'))) {
    if (/:\s*$/.test(p.textContent ?? '') && isFigureLike(p.nextElementSibling)) p.classList.add('keep-with-next');
  }

  // 5. Wide tables: scale down to fit (not below 60 %), wrapping long cells if that is not enough.
  const body = document.querySelector<HTMLElement>('.markdown-body') ?? document.body;
  const available = body.clientWidth;
  let tables = 0;
  for (const table of Array.from(document.querySelectorAll<HTMLTableElement>('table'))) {
    let width = table.getBoundingClientRect().width;
    if (width <= available + 1) continue;
    tables++;
    if (available / width < 0.6) {
      table.classList.add('wide-wrap');
      width = table.getBoundingClientRect().width;
    }
    if (width > available + 1) {
      const zoom = Math.max(0.6, Math.floor((available / width) * 1000) / 1000);
      table.classList.add('wide-scaled');
      table.style.setProperty('zoom', String(zoom));
    }
  }

  return { warnings, tables, keptBlocks };
}

function footerTemplate(theme: PageTheme): string {
  const color = theme === 'dark' ? '#9198a1' : '#6e7781';
  return `<div style="font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 8px; width: 100%; text-align: center; color: ${color};"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`;
}

export async function printPdf(
  browser: Browser,
  options: PrintOptions,
): Promise<{ pdf: Uint8Array; warnings: string[]; remoteFailures: number }> {
  const warnings: string[] = [];
  const stats = { remoteFailures: 0 };
  const page = await browser.newPage();
  try {
    await page.setJavaScriptEnabled(false);
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    const docUrl = new URL(options.documentUrl);
    const docDir = options.docPath.slice(0, options.docPath.lastIndexOf('/'));
    await page.setRequestInterception(true);
    page.on(
      'request',
      createRequestHandler({
        pages: new Map([[docUrl.pathname, options.html]]),
        assetsDir: options.assetsDir,
        readResource: options.readResource,
        allowRemoteImages: options.allowRemoteImages,
        docDir,
        warnings,
        log: options.log,
        stats,
      }),
    );
    // Lay the page out at the printable width, so the measurements below match the PDF.
    await page.setViewport({ width: Math.floor(contentBox(options.pageSize).widthPx), height: 1200 });
    await page.emulateMediaType('print');
    await page.goto(options.documentUrl, { waitUntil: 'load', timeout: 30_000 });
    const fixes = await page.evaluate(fixupDocument, { origin: ORIGIN, fsPrefix: FS_PREFIX, docPath: options.docPath });
    warnings.push(...fixes.warnings);

    const pdf = await page.pdf({
      format: options.pageSize as PaperFormat,
      margin: {
        top: `${PAGE_MARGINS_MM.top}mm`,
        bottom: `${PAGE_MARGINS_MM.bottom}mm`,
        left: `${PAGE_MARGINS_MM.left}mm`,
        right: `${PAGE_MARGINS_MM.right}mm`,
      },
      printBackground: true,
      tagged: true,
      outline: true,
      displayHeaderFooter: options.pageNumbers,
      headerTemplate: '<div></div>',
      footerTemplate: footerTemplate(options.theme),
      preferCSSPageSize: false,
      timeout: 60_000,
    });
    return { pdf, warnings, remoteFailures: stats.remoteFailures };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export { DOC_SUFFIX };
