import type { PageSize, PageTheme } from '../shared/types';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export interface ConverterOptions {
  /** Absolute path of the extension's `dist/assets` folder (print.css, KaTeX, Mermaid). */
  assetsDir: string;
  /** Absolute path of the extension's global storage folder (downloaded Chromium, browser profile). */
  storageDir: string;
  log: Logger;
}

export interface RenderRequest {
  markdown: string;
  /** URI path of the Markdown file, e.g. `/c:/Users/me/notes/doc.md`. Relative URLs resolve against it. */
  docPath: string;
  /** URI path of the workspace folder that contains the file; `/img.png` resolves against it. */
  workspaceRootPath?: string;
  /** File name shown as the PDF title when the document has no front-matter title or H1. */
  fileName: string;
  pageSize: PageSize;
  pageNumbers: boolean;
  allowRemoteImages: boolean;
  theme: PageTheme;
  chromiumPath?: string;
  /** Reads a resource (image, stylesheet, font) by URI path. Read-only; supplied by the host. */
  readResource(uriPath: string): Promise<Uint8Array>;
}

export interface RenderResult {
  pdf: Uint8Array;
  warnings: string[];
  title: string;
  browser: string;
  timings: Record<string, number>;
}

export interface ResolvedBrowser {
  executablePath: string;
  /** Where it was found: the setting, an installed browser, or the downloaded headless shell. */
  source: 'setting' | 'system' | 'downloaded';
  /** chrome-headless-shell needs `headless: 'shell'`. */
  headlessShell: boolean;
}

export class BrowserNotFoundError extends Error {
  constructor(message = 'No Chrome, Edge or Chromium installation was found.') {
    super(message);
    this.name = 'BrowserNotFoundError';
  }
}

export class BrowserLaunchError extends Error {
  constructor(
    message: string,
    readonly executablePath: string,
    readonly source: ResolvedBrowser['source'],
  ) {
    super(message);
    this.name = 'BrowserLaunchError';
  }
}

export class InvalidChromiumPathError extends Error {
  constructor(readonly configuredPath: string) {
    super(`The configured browser path does not exist: ${configuredPath}`);
    this.name = 'InvalidChromiumPathError';
  }
}
