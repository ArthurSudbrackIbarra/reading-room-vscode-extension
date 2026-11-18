// The translate tool on the host: takes a viewer's request, tells the language, gets the language
// packs it needs (asking before a download), and translates in a worker thread.
//
// Everything happens on this computer. The only network use is downloading a language pack from
// Mozilla's storage, after the reader agreed to it; the text that is translated goes nowhere.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  AUTO,
  MAX_TRANSLATE_CHARS,
  chunkText,
  defaultTarget,
  joinTranslated,
  languageName,
  languagesOf,
  packLabel,
  routeFor,
  type TranslateLanguage,
  type TranslateRequest,
  type TranslationUpdate,
} from '../shared/translate';
import { SECTION, readSettings } from '../util/settings';
import { EngineWorker } from './EngineWorker';
import { PackError, PackStore, type InstalledPack } from './PackStore';
import { REGISTRY_URL, downloadBytes, megabytes, packsOfRegistry, parsePackList, type Pack, type PackList } from './registry';

/** The folder of the language packs, in the extension's storage folder. */
export const TRANSLATION_FOLDER = 'translation';

interface Job {
  cancelled: boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function listed(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export class TranslationService implements vscode.Disposable {
  private readonly store: PackStore;
  private readonly engine: EngineWorker;
  /** The list of packs shipped with the extension. */
  private shipped?: PackList;
  /** Mozilla's list as it is now: read only after a file of the shipped list turned out to be gone. */
  private live?: PackList;
  private menu?: TranslateLanguage[];
  /** Requests are served one at a time: they share the translator, and two must not ask about the same download. */
  private queue: Promise<void> = Promise.resolve();
  /** The request each viewer is waiting for (a new one, or closing the result, cancels it). */
  private readonly jobs = new Map<object, Job>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.store = new PackStore(join(context.globalStorageUri.fsPath, TRANSLATION_FOLDER));
    this.engine = new EngineWorker(join(context.extensionUri.fsPath, 'dist', 'translate', 'worker.js'), (message) => log.warn(message));
  }

  private get packs(): PackList {
    this.shipped ??= parsePackList(readFileSync(join(this.context.extensionUri.fsPath, 'dist', 'translate', 'models.json'), 'utf8'));
    return this.shipped;
  }

  private packOf(pair: string): Pack | undefined {
    return this.live?.packs[pair] ?? this.packs.packs[pair];
  }

  /** The languages of the menus (none when the list of packs is missing from this build). */
  languages(): TranslateLanguage[] {
    if (!this.menu) {
      try {
        this.menu = languagesOf(Object.keys(this.packs.packs));
      } catch (err) {
        this.log.error(`The list of language packs could not be read: ${errorText(err)}`);
        this.menu = [];
      }
    }
    return this.menu;
  }

  /** The language new translations are into until the reader picks one: the language of VS Code. */
  defaultTarget(): string {
    return defaultTarget(vscode.env.language, this.languages());
  }

  /**
   * Translates for a viewer (`owner`), reporting how it goes. A request of the same viewer that is
   * still waiting or running is dropped for it.
   */
  translate(owner: object, request: TranslateRequest, report: (update: TranslationUpdate) => void): Promise<void> {
    this.cancel(owner);
    const job: Job = { cancelled: false };
    this.jobs.set(owner, job);
    const tell = (update: TranslationUpdate): void => {
      if (!job.cancelled) report(update);
    };
    const run = this.queue.then(async () => {
      if (job.cancelled) return;
      try {
        await this.run(job, request, tell);
      } catch (err) {
        this.log.error(`Translating failed: ${errorText(err)}`);
        tell({ status: 'error', problem: 'failed', message: `The translation failed: ${errorText(err)}`, to: request.to });
      } finally {
        if (this.jobs.get(owner) === job) this.jobs.delete(owner);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The viewer does not wait for its translation any more. (A download that is under way goes on: the reader agreed to it.) */
  cancel(owner: object): void {
    const job = this.jobs.get(owner);
    if (job) job.cancelled = true;
    this.jobs.delete(owner);
  }

  private async run(job: Job, request: TranslateRequest, tell: (update: TranslationUpdate) => void): Promise<void> {
    const { text, to } = request;
    const languages = this.languages();
    if (!languages.some((language) => language.code === to && language.to)) {
      tell({ status: 'error', problem: 'failed', message: `There is no language pack that translates into ${languageName(to)}.`, to });
      return;
    }
    if (text.length > MAX_TRANSLATE_CHARS) {
      tell({ status: 'error', problem: 'too-long', message: `That is more than ${MAX_TRANSLATE_CHARS.toLocaleString('en-US')} characters. Select less to translate it.`, to });
      return;
    }

    let from = request.from;
    const detected = from === AUTO;
    if (detected) {
      tell({ status: 'working', step: 'detecting', to });
      const sources = languages.filter((language) => language.from).map((language) => language.code);
      const found = await this.engine.detect(text, request.context, sources);
      if (job.cancelled) return;
      if (!found) {
        tell({ status: 'error', problem: 'undetected', message: 'Reading Room could not tell which language this is. Choose it in the first menu.', to });
        return;
      }
      from = found;
    }
    if (!languages.some((language) => language.code === from && language.from)) {
      tell({ status: 'error', problem: 'unsupported', message: `There is no language pack that translates from ${languageName(from)}.`, from, to });
      return;
    }

    const route = routeFor(from, to, (pair) => this.packOf(pair) !== undefined);
    if ('problem' in route) {
      const name = languageName(to);
      const message =
        route.problem !== 'same'
          ? `There is no language pack to translate ${languageName(from)} into ${name}.`
          : detected
            ? `This looks like it is in ${name} already. If it is not, choose its language in the first menu.`
            : `Both languages are ${name}. Choose another one in either menu.`;
      tell({ status: 'error', problem: route.problem === 'same' ? 'same' : 'unsupported', message, from, to });
      return;
    }

    const missing: string[] = [];
    for (const pair of route.packs) if (!(await this.store.get(pair))) missing.push(pair);
    if (missing.length > 0) {
      const problem = await this.acquire(missing, (step, progress) => tell({ status: 'working', step, from, to, progress }));
      if (problem) {
        tell({ status: 'error', ...problem, from, to });
        return;
      }
    }
    if (job.cancelled) return;

    const packs: InstalledPack[] = [];
    for (const pair of route.packs) {
      const pack = await this.store.get(pair);
      if (!pack) throw new Error(`The ${packLabel(pair)} language pack is not on this computer.`);
      packs.push(pack);
    }
    tell({ status: 'working', step: 'translating', from, to });
    const started = Date.now();
    const pieces: string[] = [];
    for (const chunk of chunkText(text)) {
      if (job.cancelled) return;
      pieces.push(await this.engine.translate(packs, chunk));
      tell({ status: 'working', step: 'translating', from, to, text: joinTranslated(pieces, to) });
    }
    this.log.info(
      `Translated ${text.length} characters, ${from} to ${to}${packs.length > 1 ? ' by way of English' : ''}, in ${Date.now() - started} ms (the translator holds ${megabytes(this.engine.heapBytes)})`,
    );
    tell({ status: 'done', from, to, text: joinTranslated(pieces, to), pivot: packs.length > 1, detected });
  }

  // ---------- Language packs ----------

  /**
   * Gets the packs that are missing: asks first, then downloads them. Returns what went wrong (to
   * say in the viewer), or undefined when they are all here.
   */
  private async acquire(
    pairs: string[],
    progress: (step: 'asking' | 'downloading', fraction?: number) => void,
  ): Promise<{ problem: 'declined' | 'download-failed'; message: string } | undefined> {
    const names = pairs.map(packLabel);
    const what = pairs.length === 1 ? `the ${names[0]} language pack` : `the language packs ${listed(names)}`;
    if (readSettings().translationDownload === 'never') {
      return { problem: 'declined', message: `This needs ${what}, and downloading language packs is turned off in the settings ("${SECTION}.translationDownload").` };
    }
    progress('asking');
    const sizes = pairs.map((pair) => megabytes(downloadBytes(this.packOf(pair) as Pack)));
    const total = megabytes(pairs.reduce((sum, pair) => sum + downloadBytes(this.packOf(pair) as Pack), 0));
    const detail = [
      pairs.length === 1
        ? `It is about ${sizes[0]}.`
        : `${names.map((name, i) => `${name} (about ${sizes[i]})`).join(' and ')}: about ${total} in all. Between two other languages, Reading Room translates by way of English.`,
      "Reading Room translates on this computer, with the language packs Mozilla makes for Firefox. A pack is downloaded once, from Mozilla's storage into VS Code's storage for this extension.",
      'After that, translating between these languages works offline, and what you translate never leaves this computer.',
    ].join('\n\n');
    const choice = await vscode.window.showInformationMessage(
      pairs.length === 1 ? `Download the ${names[0]} language pack?` : `Download ${pairs.length} language packs?`,
      { modal: true, detail },
      'Download',
    );
    if (choice !== 'Download') return { problem: 'declined', message: `Nothing was downloaded. Translating this needs ${what}.` };
    try {
      await this.download(pairs, (fraction) => progress('downloading', fraction));
      return undefined;
    } catch (err) {
      if (err instanceof PackError && err.kind === 'cancelled') return { problem: 'declined', message: 'The download was cancelled.' };
      this.log.error(`Downloading ${what} failed: ${errorText(err)}`);
      const offline = err instanceof PackError && err.kind === 'network';
      return {
        problem: 'download-failed',
        message: offline
          ? `Downloading ${what} failed. Check the connection (and VS Code's proxy settings, behind a proxy), then try again.`
          : `Downloading ${what} failed: ${errorText(err)} The log has more ("Reading Room: Show Log").`,
      };
    }
  }

  /** Downloads packs with a notification that shows how far it is and can cancel it. */
  private async download(pairs: string[], onFraction?: (fraction: number) => void): Promise<void> {
    const packs = pairs.map((pair) => this.packOf(pair) as Pack);
    const total = packs.reduce((sum, pack) => sum + downloadBytes(pack), 0);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Reading Room: downloading ${listed(pairs.map(packLabel))}`, cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        let before = 0;
        let reported = 0;
        for (const [i, pair] of pairs.entries()) {
          const size = downloadBytes(packs[i]);
          const onProgress = (received: number): void => {
            const percent = Math.min(100, ((before + Math.min(received, size)) / total) * 100);
            if (percent - reported < 1 && percent < 100) return;
            progress.report({ increment: percent - reported, message: `${Math.round((before + received) / 1_000_000)} of ${Math.round(total / 1_000_000)} MB` });
            reported = percent;
            onFraction?.(percent / 100);
          };
          await this.install(pair, { onProgress, signal: abort.signal });
          before += size;
        }
      },
    );
    this.log.info(`Downloaded ${listed(pairs.map(packLabel))} into ${join(this.context.globalStorageUri.fsPath, TRANSLATION_FOLDER)}`);
  }

  /** Installs one pack. When the shipped list points at a file that is gone (Mozilla trained the model again), Mozilla's list as it is now is read, once, and tried. */
  private async install(pair: string, options: { onProgress(received: number): void; signal: AbortSignal }): Promise<void> {
    const pack = this.packOf(pair);
    if (!pack) throw new Error(`There is no ${packLabel(pair)} language pack.`);
    try {
      await this.store.install(pack, options);
    } catch (err) {
      if (!(err instanceof PackError) || err.kind !== 'gone' || this.live) throw err;
      this.log.warn(`${errorText(err)} Reading Mozilla's list of models again.`);
      let registry: unknown;
      try {
        const response = await fetch(REGISTRY_URL, { signal: options.signal });
        if (!response.ok) throw new Error(`${REGISTRY_URL} answered ${response.status}`, { cause: err });
        registry = await response.json();
      } catch (inner) {
        throw new PackError('network', `Mozilla's list of models could not be read: ${errorText(inner)}`, { cause: inner });
      }
      this.live = packsOfRegistry(registry, new Date().toISOString());
      const fresh = this.live.packs[pair];
      if (!fresh) throw new PackError('gone', `Mozilla does not offer a ${packLabel(pair)} language pack any more.`);
      await this.store.install(fresh, options);
    }
  }

  /** The command "Manage Translation Languages…": what is on this computer, removing a pack, downloading one ahead of time. */
  async manage(): Promise<void> {
    const languages = this.languages();
    if (languages.length === 0) {
      void vscode.window.showErrorMessage('Reading Room: this build has no list of language packs, so the translate tool is not available.');
      return;
    }
    type Item = vscode.QuickPickItem & { run?: () => Promise<void> };
    const installed = await this.store.installed();
    const items: Item[] = [
      {
        label: '$(cloud-download) Download a language…',
        detail: 'Get the packs of a language now, to translate it later without a connection.',
        run: () => this.pickDownload(installed),
      },
    ];
    if (installed.length > 0) {
      items.push({ label: `On this computer: ${megabytes(installed.reduce((sum, pack) => sum + pack.bytes, 0))}`, kind: vscode.QuickPickItemKind.Separator });
      for (const pack of installed) {
        items.push({ label: packLabel(pack.pair), description: megabytes(pack.bytes), detail: 'Pick to remove it from this computer.', run: () => this.removePack(pack) });
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Reading Room: Translation Languages',
      placeHolder: installed.length > 0 ? 'Download a language, or pick a language pack to remove it' : 'No language pack is on this computer yet',
    });
    await picked?.run?.();
  }

  private async pickDownload(installed: InstalledPack[]): Promise<void> {
    const have = new Set(installed.map((pack) => pack.pair));
    const options = this.languages()
      .filter((language) => language.code !== 'en')
      .map((language) => {
        const route = [routeFor(language.code, 'en', (pair) => this.packOf(pair) !== undefined), routeFor('en', language.code, (pair) => this.packOf(pair) !== undefined)];
        const pairs = [...new Set(route.flatMap((r) => ('packs' in r ? r.packs : [])))];
        const missing = pairs.filter((pair) => !have.has(pair));
        const size = megabytes(missing.reduce((sum, pair) => sum + downloadBytes(this.packOf(pair) as Pack), 0));
        return {
          label: language.name,
          description: missing.length === 0 ? 'on this computer' : `about ${size}`,
          detail: language.from && language.to ? undefined : language.from ? 'Only from this language, not into it.' : 'Only into this language, not from it.',
          missing,
        };
      });
    const picked = await vscode.window.showQuickPick(options, {
      title: 'Reading Room: Download a Language',
      placeHolder: 'The packs of a language translate it to and from English',
      matchOnDescription: true,
    });
    if (!picked) return;
    if (picked.missing.length === 0) {
      void vscode.window.showInformationMessage(`The language packs of ${picked.label} are on this computer already.`);
      return;
    }
    const problem = await this.acquireInTurn(picked.missing);
    if (problem) void vscode.window.showWarningMessage(`Reading Room: ${problem}`);
    else void vscode.window.showInformationMessage(`Reading Room can now translate ${picked.label} without a connection.`);
  }

  /** A download asked for from the command waits for its turn like a translation does. */
  private acquireInTurn(pairs: string[]): Promise<string | undefined> {
    const run = this.queue.then(async () => (await this.acquire(pairs, () => undefined))?.message);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async removePack(pack: InstalledPack): Promise<void> {
    const label = packLabel(pack.pair);
    const choice = await vscode.window.showWarningMessage(
      `Remove the ${label} language pack?`,
      { modal: true, detail: `It frees ${megabytes(pack.bytes)}. Translating with it again downloads it again.` },
      'Remove',
    );
    if (choice !== 'Remove') return;
    const run = this.queue.then(async () => {
      // The translator may have the files of the pack open.
      this.engine.stop();
      await this.store.remove(pack.pair);
    });
    this.queue = run.catch(() => undefined);
    try {
      await run;
      this.log.info(`Removed the ${label} language pack`);
    } catch (err) {
      this.log.error(`Removing the ${label} language pack failed: ${errorText(err)}`);
      void vscode.window.showErrorMessage(`Reading Room could not remove the ${label} language pack: ${errorText(err)}`);
    }
  }

  dispose(): void {
    for (const job of this.jobs.values()) job.cancelled = true;
    this.jobs.clear();
    this.engine.dispose();
  }
}
