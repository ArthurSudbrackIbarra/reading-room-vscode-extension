// The worker thread of the translate tool (dist/translate/worker.js). Telling the language and
// translating both run here, so the extension host never waits for them, and the memory the
// translator takes (hundreds of megabytes while it is used) is given back when the thread ends.
import { parentPort } from 'node:worker_threads';
import { detectLanguage } from './detect';
import { Engine, type ModelFiles } from './engine';

export type WorkerRequest =
  | { id: number; op: 'detect'; text: string; context?: string; allowed: string[] }
  | { id: number; op: 'load'; key: string; files: ModelFiles }
  | { id: number; op: 'translate'; keys: string[]; text: string };

export type WorkerReply = { id: number; result: unknown; heapBytes?: number } | { id: number; error: string };

let engine: Promise<Engine> | undefined;

async function handle(request: WorkerRequest): Promise<{ result: unknown; heapBytes?: number }> {
  if (request.op === 'detect') return { result: detectLanguage(request.text, request.context, request.allowed) };
  // The two files of the engine are next to this bundle.
  engine ??= Engine.load(__dirname);
  const loaded = await engine;
  if (request.op === 'load') {
    loaded.loadModel(request.key, request.files);
    return { result: true, heapBytes: loaded.heapBytes };
  }
  return { result: loaded.translate(request.keys, request.text), heapBytes: loaded.heapBytes };
}

parentPort?.on('message', (request: WorkerRequest) => {
  handle(request).then(
    (reply) => parentPort?.postMessage({ id: request.id, ...reply } satisfies WorkerReply),
    (err: unknown) => parentPort?.postMessage({ id: request.id, error: err instanceof Error ? err.message : String(err) } satisfies WorkerReply),
  );
});
