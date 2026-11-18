// The extension host's side of the translator's worker thread: starts it when it is needed, loads
// the language packs a translation takes, and ends it when it has not been used for a while.
// Ending the thread is what gives its memory back: the translator holds hundreds of megabytes
// once it has translated something, and never returns them while it runs. For the same reason
// the thread is started afresh when another pair of languages is asked for, instead of loading
// more models into the same one.
import { Worker } from 'node:worker_threads';
import type { InstalledPack } from './PackStore';
import type { WorkerReply, WorkerRequest } from './worker';

type Sent<T> = T extends { id: number } ? Omit<T, 'id'> : never;

/** One pack as it is loaded: a new download of the same direction is another model. */
function keyOf(pack: InstalledPack): string {
  return `${pack.pair}@${pack.installedAt}`;
}

export class EngineWorker {
  private worker?: Worker;
  private readonly loaded = new Set<string>();
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private seq = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  /** The memory the translator holds now (as its last answer said), for the log. */
  heapBytes = 0;

  constructor(
    private readonly script: string,
    private readonly log: (message: string) => void,
    private readonly idleMs = 60_000,
  ) {}

  /** The language of a text among `allowed`, or undefined. */
  async detect(text: string, context: string | undefined, allowed: string[]): Promise<string | undefined> {
    const found = await this.call({ op: 'detect', text, context, allowed });
    return typeof found === 'string' ? found : undefined;
  }

  /** Translates with one pack, or with two in a row. Their models are loaded first when they are not. */
  async translate(packs: InstalledPack[], text: string): Promise<string> {
    const keys = packs.map(keyOf);
    // Other models in memory: start over, so that what they hold is given back.
    if ([...this.loaded].some((key) => !keys.includes(key))) this.stop();
    try {
      for (const pack of packs) {
        const key = keyOf(pack);
        if (this.loaded.has(key)) continue;
        await this.call({ op: 'load', key, files: { model: pack.model, shortlist: pack.shortlist, vocabs: pack.vocabs } });
        this.loaded.add(key);
      }
      return String(await this.call({ op: 'translate', keys, text }));
    } catch (err) {
      // Whatever went wrong may have left the translator in a state it does not recover from.
      this.stop();
      throw err;
    }
  }

  private call(request: Sent<WorkerRequest>): Promise<unknown> {
    const worker = this.start();
    clearTimeout(this.idleTimer);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...request });
    }).finally(() => {
      if (this.pending.size === 0 && this.worker) this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    });
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.script);
    this.worker = worker;
    worker.on('message', (reply: WorkerReply) => {
      const waiting = this.pending.get(reply.id);
      if (!waiting) return;
      this.pending.delete(reply.id);
      if ('error' in reply) {
        waiting.reject(new Error(reply.error));
        return;
      }
      if (reply.heapBytes) this.heapBytes = reply.heapBytes;
      waiting.resolve(reply.result);
    });
    const ended = (why: string): void => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.loaded.clear();
      this.failPending(new Error(why));
    };
    worker.on('error', (err) => {
      this.log(`The translator's worker failed: ${err instanceof Error ? err.message : String(err)}`);
      ended(`The translator stopped: ${err instanceof Error ? err.message : String(err)}`);
    });
    worker.on('exit', () => ended('The translator stopped.'));
    // An idle worker does not keep VS Code from closing.
    worker.unref();
    return worker;
  }

  private failPending(error: Error): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiting) reject(error);
  }

  /** Ends the worker thread (and with it everything the translator holds in memory). The next call starts a new one. */
  stop(): void {
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    this.worker = undefined;
    this.loaded.clear();
    this.heapBytes = 0;
    if (!worker) return;
    this.failPending(new Error('The translator was stopped.'));
    void worker.terminate();
  }

  get running(): boolean {
    return this.worker !== undefined;
  }

  dispose(): void {
    this.stop();
  }
}
