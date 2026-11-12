// Finding, downloading and running the headless browser used for HTML → PDF.
//
// Resolution order: the `chromiumPath` setting, an installed Chrome (via @puppeteer/browsers),
// Edge / Chromium / Brave in their standard locations, then a chrome-headless-shell that was
// previously downloaded into the extension's global storage. Downloading is the host's call
// (it asks the user first); see `download()`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform as osPlatform } from 'node:os';
import puppeteer, { type Browser } from 'puppeteer-core';
import {
  Browser as BrowserKind,
  ChromeReleaseChannel,
  computeSystemExecutablePath,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId,
  uninstall,
} from '@puppeteer/browsers';
import { BrowserLaunchError, BrowserNotFoundError, InvalidChromiumPathError, type Logger, type ResolvedBrowser } from './types';

/** The chrome-headless-shell build pinned by puppeteer-core 25.16, used if "stable" can't be resolved. */
const PINNED_HEADLESS_SHELL = '156.0.8078.47';
const IDLE_CLOSE_MS = 120_000;

function windowsCandidates(): string[] {
  const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter((r): r is string => !!r);
  const rel = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
    'Chromium\\Application\\chrome.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];
  return rel.flatMap((r) => roots.map((root) => join(root, r)));
}

function macCandidates(): string[] {
  const apps = [
    'Google Chrome.app/Contents/MacOS/Google Chrome',
    'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'Chromium.app/Contents/MacOS/Chromium',
    'Brave Browser.app/Contents/MacOS/Brave Browser',
  ];
  const home = process.env['HOME'];
  return apps.flatMap((a) => [join('/Applications', a), ...(home ? [join(home, 'Applications', a)] : [])]);
}

function linuxCandidates(): string[] {
  const names = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge', 'brave-browser'];
  return [...names.flatMap((n) => [`/usr/bin/${n}`, `/usr/local/bin/${n}`]), '/snap/bin/chromium', '/opt/google/chrome/chrome'];
}

function systemCandidates(): string[] {
  const out: string[] = [];
  const platform = detectBrowserPlatform();
  if (platform) {
    try {
      out.push(computeSystemExecutablePath({ browser: BrowserKind.CHROME, channel: ChromeReleaseChannel.STABLE, platform }, false));
    } catch {
      // Chrome stable has no known location on this platform.
    }
  }
  const os = osPlatform();
  out.push(...(os === 'win32' ? windowsCandidates() : os === 'darwin' ? macCandidates() : linuxCandidates()));
  return [...new Set(out)];
}

export interface Lease {
  browser: Browser;
  release(): void;
}

export class BrowserManager {
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private launchedWith?: string;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private leases = 0;
  private disposed = false;
  /** The browser in use, for log messages. */
  current?: ResolvedBrowser;

  constructor(
    private readonly storageDir: string,
    private readonly log: Logger,
  ) {}

  get cacheDir(): string {
    return join(this.storageDir, 'chromium');
  }

  /** All usable candidates in preference order. Throws if a configured path is missing. */
  async candidates(configuredPath?: string): Promise<ResolvedBrowser[]> {
    const configured = configuredPath?.trim();
    if (configured) {
      if (!existsSync(configured)) throw new InvalidChromiumPathError(configured);
      return [{ executablePath: configured, source: 'setting', headlessShell: /headless[-_]shell/i.test(configured) }];
    }
    const found: ResolvedBrowser[] = systemCandidates()
      .filter((p) => existsSync(p))
      .map((p) => ({ executablePath: p, source: 'system' as const, headlessShell: false }));
    const downloaded = await this.downloadedBrowser();
    if (downloaded) found.push(downloaded);
    return found;
  }

  async downloadedBrowser(): Promise<ResolvedBrowser | undefined> {
    if (!existsSync(this.cacheDir)) return undefined;
    try {
      const installed = (await getInstalledBrowsers({ cacheDir: this.cacheDir }))
        .filter((b) => b.browser === BrowserKind.CHROMEHEADLESSSHELL && existsSync(b.executablePath))
        .sort((a, b) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }));
      const best = installed[0];
      return best ? { executablePath: best.executablePath, source: 'downloaded', headlessShell: true } : undefined;
    } catch (err) {
      this.log.warn(`Could not list downloaded browsers: ${String(err)}`);
      return undefined;
    }
  }

  /** Downloads chrome-headless-shell into global storage. Progress is reported in bytes. */
  async download(onProgress: (downloaded: number, total: number) => void): Promise<ResolvedBrowser> {
    const platform = detectBrowserPlatform();
    if (!platform) throw new Error(`Downloading Chromium is not supported on ${osPlatform()} ${process.arch}.`);
    let buildId = PINNED_HEADLESS_SHELL;
    try {
      buildId = await resolveBuildId(BrowserKind.CHROMEHEADLESSSHELL, platform, 'stable');
    } catch (err) {
      this.log.warn(`Could not resolve the latest stable chrome-headless-shell, using ${buildId}: ${String(err)}`);
    }
    this.log.info(`Downloading chrome-headless-shell ${buildId} for ${platform} into ${this.cacheDir}`);
    const installed = await install({
      browser: BrowserKind.CHROMEHEADLESSSHELL,
      buildId,
      platform,
      cacheDir: this.cacheDir,
      downloadProgressCallback: onProgress,
    });
    for (const old of await getInstalledBrowsers({ cacheDir: this.cacheDir })) {
      if (old.browser === BrowserKind.CHROMEHEADLESSSHELL && old.buildId !== buildId) {
        await uninstall({ browser: old.browser, buildId: old.buildId, platform: old.platform, cacheDir: this.cacheDir }).catch((err: unknown) =>
          this.log.warn(`Could not remove old browser ${old.buildId}: ${String(err)}`),
        );
      }
    }
    this.log.info(`Installed chrome-headless-shell at ${installed.executablePath}`);
    return { executablePath: installed.executablePath, source: 'downloaded', headlessShell: true };
  }

  /** Returns a running browser. Call `release()` when done so the idle timer can close it. */
  async acquire(configuredPath?: string): Promise<Lease> {
    if (this.disposed) throw new Error('The converter has been disposed.');
    this.leases++;
    clearTimeout(this.idleTimer);
    try {
      const key = configuredPath?.trim() ?? '';
      if (this.browser?.connected && this.launchedWith !== key) {
        await this.closeBrowser();
      }
      if (!this.browser?.connected) {
        this.launching ??= this.launch(configuredPath).finally(() => {
          this.launching = undefined;
        });
        this.browser = await this.launching;
        this.launchedWith = key;
      }
      const browser = this.browser;
      let released = false;
      return {
        browser,
        release: () => {
          if (released) return;
          released = true;
          this.releaseLease();
        },
      };
    } catch (err) {
      this.releaseLease();
      throw err;
    }
  }

  private releaseLease(): void {
    this.leases = Math.max(0, this.leases - 1);
    if (this.leases === 0 && this.browser) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.leases === 0) void this.closeBrowser();
      }, IDLE_CLOSE_MS);
      this.idleTimer.unref?.();
    }
  }

  private async launch(configuredPath?: string): Promise<Browser> {
    const candidates = await this.candidates(configuredPath);
    if (candidates.length === 0) throw new BrowserNotFoundError();
    let firstError: BrowserLaunchError | undefined;
    for (const candidate of candidates) {
      try {
        const started = performance.now();
        const browser = await puppeteer.launch({
          executablePath: candidate.executablePath,
          headless: candidate.headlessShell ? 'shell' : true,
          pipe: true,
          // No userDataDir: puppeteer creates a fresh profile in the OS temp folder and deletes it on close.
          args: [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-component-update',
            '--disable-default-apps',
            '--hide-scrollbars',
            '--mute-audio',
            ...(osPlatform() === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
          ],
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          timeout: 30_000,
          protocolTimeout: 120_000,
        });
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = undefined;
        });
        this.current = candidate;
        this.log.info(`Started ${await browser.version()} from ${candidate.executablePath} (${candidate.source}) in ${Math.round(performance.now() - started)} ms`);
        return browser;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(`Could not start ${candidate.executablePath}: ${message}`);
        firstError ??= new BrowserLaunchError(message, candidate.executablePath, candidate.source);
        if (candidate.source === 'setting') break;
      }
    }
    throw firstError ?? new BrowserNotFoundError();
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    clearTimeout(this.idleTimer);
    if (browser) {
      this.log.info('Closing the headless browser');
      await browser.close().catch((err: unknown) => this.log.warn(`Closing the browser failed: ${String(err)}`));
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.launching?.catch(() => undefined);
    await this.closeBrowser();
  }
}
