// Host-side glue for the converter bundle: loads it lazily, supplies read-only file access,
// and turns "no browser" situations into actionable prompts (download, choose a path, …).
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import type { CacheDependency } from '../cache/PdfCache';
import type * as ConverterModule from '../converter/index';
import type { AnnotatedPdf, ExportAnnotations } from '../export/annotate';
import type { PageTheme } from '../shared/types';
import { readSettings, SECTION } from '../util/settings';

type ConverterApi = typeof ConverterModule;
type Converter = InstanceType<ConverterApi['Converter']>;
type RenderResult = Awaited<ReturnType<Converter['render']>> & {
  /** Local files the render read, for invalidating the disk cache when they change. */
  deps: CacheDependency[];
};

export interface RenderInput {
  uri: vscode.Uri;
  text: string;
  kind: 'markdown' | 'text';
}

export class RenderError extends Error {
  constructor(
    message: string,
    readonly reported: boolean,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

function errorName(err: unknown): string {
  return err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class RenderService implements vscode.Disposable {
  private modulePromise?: Promise<ConverterApi>;
  private converterPromise?: Promise<Converter>;
  /** One modal "no browser" prompt at a time, shared by all panels. */
  private browserPrompt?: Promise<boolean>;
  /** Non-modal browser errors currently on screen (not repeated on every save). */
  private readonly notifying = new Set<string>();
  private readonly browserFixed = new vscode.EventEmitter<void>();
  /** Fires when the user fixed a browser problem from a notification; previews should re-render. */
  readonly onDidFixBrowser = this.browserFixed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  private loadModule(): Promise<ConverterApi> {
    this.modulePromise ??= (async () => {
      const started = Date.now();
      const url = pathToFileURL(this.context.asAbsolutePath('dist/converter/index.mjs')).href;
      const mod = (await import(url)) as ConverterApi;
      this.log.info(`Loaded the converter in ${Date.now() - started} ms`);
      return mod;
    })();
    this.modulePromise.catch(() => {
      this.modulePromise = undefined;
    });
    return this.modulePromise;
  }

  private converter(): Promise<Converter> {
    this.converterPromise ??= this.loadModule().then(
      (mod) =>
        new mod.Converter({
          assetsDir: this.context.asAbsolutePath('dist/assets'),
          storageDir: this.context.globalStorageUri.fsPath,
          log: this.log,
        }),
    );
    this.converterPromise.catch(() => {
      this.converterPromise = undefined;
    });
    return this.converterPromise;
  }

  async render(input: RenderInput, theme: PageTheme): Promise<RenderResult> {
    const converter = await this.converter();
    const attempt = async (): Promise<RenderResult> => {
      const settings = readSettings();
      const folder = vscode.workspace.getWorkspaceFolder(input.uri);
      const deps = new Map<string, CacheDependency>();
      const result = await converter.render({
        kind: input.kind,
        markdown: input.text,
        docPath: input.uri.path,
        workspaceRootPath: folder && folder.uri.scheme === input.uri.scheme && folder.uri.authority === input.uri.authority ? folder.uri.path : undefined,
        fileName: input.uri.path.split('/').pop() ?? 'document',
        pageSize: settings.pageSize,
        pageNumbers: settings.pageNumbers,
        allowRemoteImages: settings.allowRemoteImages,
        theme,
        chromiumPath: settings.chromiumPath || undefined,
        readResource: async (uriPath: string) => {
          const uri = input.uri.with({ path: uriPath, query: '', fragment: '' });
          try {
            const [bytes, stat] = await Promise.all([vscode.workspace.fs.readFile(uri), vscode.workspace.fs.stat(uri)]);
            deps.set(uriPath, { path: uriPath, size: stat.size, mtime: stat.mtime });
            return bytes;
          } catch (err) {
            deps.set(uriPath, { path: uriPath, missing: true });
            throw err;
          }
        },
      });
      return { ...result, deps: [...deps.values()] };
    };
    try {
      return await attempt();
    } catch (err) {
      if (await this.recoverFromBrowserError(err)) return attempt();
      throw err;
    }
  }

  async annotate(pdf: Uint8Array, annotations: ExportAnnotations, password?: string): Promise<AnnotatedPdf> {
    const mod = await this.loadModule();
    return mod.annotatePdf(pdf, annotations, password);
  }

  /**
   * Returns true if the problem was fixed and the render should be retried right away.
   * Only the modal "no browser" prompt is awaited; other problems are reported in a
   * notification without blocking rendering, and fixing them later triggers a re-render.
   */
  private async recoverFromBrowserError(err: unknown): Promise<boolean> {
    const name = errorName(err);
    if (name === 'BrowserNotFoundError') {
      this.browserPrompt ??= this.promptForBrowser(err).finally(() => {
        this.browserPrompt = undefined;
      });
      return this.browserPrompt;
    }
    if (name === 'InvalidChromiumPathError' || name === 'BrowserLaunchError') {
      this.log.error(errorMessage(err));
      if (!this.notifying.has(name)) {
        this.notifying.add(name);
        void this.promptForBrowser(err)
          .then((fixed) => {
            if (fixed) this.browserFixed.fire();
          }, () => undefined)
          .finally(() => this.notifying.delete(name));
      }
      throw new RenderError(errorMessage(err), true);
    }
    return false;
  }

  private async promptForBrowser(err: unknown): Promise<boolean> {
    const name = errorName(err);
    const settings = readSettings();
    if (name === 'BrowserNotFoundError') this.log.error(errorMessage(err));

    if (name === 'InvalidChromiumPathError') {
      const choice = await vscode.window.showErrorMessage(
        `Document Viewer: the browser path in the "${SECTION}.chromiumPath" setting does not exist: ${settings.chromiumPath}`,
        'Clear the Setting',
        'Choose Browser…',
        'Open Settings',
      );
      if (choice === 'Clear the Setting') {
        await vscode.workspace.getConfiguration(SECTION).update('chromiumPath', undefined, vscode.ConfigurationTarget.Global);
        return true;
      }
      if (choice === 'Choose Browser…') return this.chooseBrowser();
      if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.chromiumPath`);
      throw new RenderError(errorMessage(err), true);
    }

    if (name === 'BrowserLaunchError') {
      const failed = err as { executablePath?: string; source?: string };
      const actions = failed.source === 'downloaded' ? ['Show Log'] : ['Download Chromium', 'Choose Browser…', 'Show Log'];
      const choice = await vscode.window.showErrorMessage(
        `Document Viewer could not start ${failed.executablePath ?? 'the browser'}. This can happen when a company policy blocks headless browsers. ${errorMessage(err)}`,
        ...actions,
      );
      if (choice === 'Download Chromium') return this.downloadBrowser();
      if (choice === 'Choose Browser…') return this.chooseBrowser();
      if (choice === 'Show Log') this.log.show(true);
      throw new RenderError(errorMessage(err), true);
    }

    // BrowserNotFoundError
    if (settings.chromiumDownload === 'never') {
      const choice = await vscode.window.showErrorMessage(
        'Document Viewer needs Chrome, Edge or Chromium to convert Markdown and text files to PDF, and none was found. Install one of them, or set the path in the settings.',
        'Choose Browser…',
        'Open Settings',
      );
      if (choice === 'Choose Browser…') return this.chooseBrowser();
      if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', SECTION);
      throw new RenderError('No Chrome, Edge or Chromium installation was found.', true);
    }
    const choice = await vscode.window.showWarningMessage(
      'Document Viewer needs Chrome, Edge or Chromium to convert Markdown and text files to PDF, and none was found.',
      {
        modal: true,
        detail:
          "Download Chromium (chrome-headless-shell, about 126 MB) into VS Code's global storage? Nothing is written to your workspace. You can also point the extension at a browser you already have.",
      },
      'Download Chromium',
      'Choose Browser…',
    );
    if (choice === 'Download Chromium') return this.downloadBrowser();
    if (choice === 'Choose Browser…') return this.chooseBrowser();
    throw new RenderError('No Chrome, Edge or Chromium installation was found.', true);
  }

  private async chooseBrowser(): Promise<boolean> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Use This Browser',
      title: 'Choose a Chrome, Edge or Chromium executable',
      filters: process.platform === 'win32' ? { Programs: ['exe'] } : undefined,
    });
    if (!picked?.[0]) throw new RenderError('No browser was chosen.', true);
    await vscode.workspace.getConfiguration(SECTION).update('chromiumPath', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    return true;
  }

  async downloadBrowser(): Promise<boolean> {
    const converter = await this.converter();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Downloading Chromium for Document Viewer', cancellable: false },
        async (progress) => {
          let reported = 0;
          await converter.downloadBrowser((downloaded, total) => {
            if (!total) return;
            const percent = Math.min(100, (downloaded / total) * 100);
            if (percent - reported >= 1 || percent === 100) {
              progress.report({
                increment: percent - reported,
                message: `${Math.round(downloaded / 1048576)} of ${Math.round(total / 1048576)} MB`,
              });
              reported = percent;
            }
          });
        },
      );
      void vscode.window.showInformationMessage('Chromium was downloaded. Document Viewer will use it from now on.');
      return true;
    } catch (err) {
      this.log.error(`Downloading Chromium failed: ${errorMessage(err)}`);
      const choice = await vscode.window.showErrorMessage(
        `Downloading Chromium failed: ${errorMessage(err)}. If you are behind a proxy, check VS Code's proxy settings.`,
        'Retry',
        'Open Proxy Settings',
        'Show Log',
      );
      if (choice === 'Retry') return this.downloadBrowser();
      if (choice === 'Open Proxy Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'http.proxy');
      if (choice === 'Show Log') this.log.show(true);
      throw new RenderError(`Downloading Chromium failed: ${errorMessage(err)}`, true);
    }
  }

  dispose(): void {
    this.browserFixed.dispose();
    void this.converterPromise?.then((c) => c.dispose()).catch(() => undefined);
  }

  async disposeAsync(): Promise<void> {
    const converter = await this.converterPromise?.catch(() => undefined);
    await converter?.dispose();
  }
}
