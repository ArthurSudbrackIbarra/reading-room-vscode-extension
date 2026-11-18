// The translator itself: Bergamot (the engine of Firefox's page translation, built to
// WebAssembly), loaded in a worker thread of the extension host. This file is the little that is
// needed around it in Node: reading the two files of the engine, giving the WebAssembly module the
// matrix routines it asks for, and passing models and text in and out.
//
// The engine's files are shipped as they are published (`@browsermt/bergamot-translator`), next
// to the bundle of the worker: `bergamot-translator-worker.js` (Emscripten's glue code) and
// `bergamot-translator-worker.wasm`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Deletable {
  delete(): void;
}

interface Vector<T> extends Deletable {
  push_back(value: T): void;
  get(index: number): T;
}

interface AlignedMemory {
  getByteArrayView(): Int8Array;
}

interface TranslationResponse {
  getTranslatedText(): string;
}

interface ResponseOptions {
  alignment: boolean;
  html: boolean;
  qualityScores: boolean;
}

interface Service extends Deletable {
  translate(model: Deletable, input: Vector<string>, options: Vector<ResponseOptions>): Vector<TranslationResponse>;
  translateViaPivoting(first: Deletable, second: Deletable, input: Vector<string>, options: Vector<ResponseOptions>): Vector<TranslationResponse>;
}

interface BergamotModule {
  HEAP8: Int8Array;
  asm: Record<string, (...args: number[]) => number>;
  AlignedMemory: new (size: number, alignment: number) => AlignedMemory;
  AlignedMemoryList: new () => Vector<AlignedMemory>;
  BlockingService: new (config: { cacheSize: number }) => Service;
  TranslationModel: new (config: string, model: AlignedMemory, shortlist: AlignedMemory | null, vocabs: Vector<AlignedMemory>, quality: null) => Deletable;
  VectorString: new () => Vector<string>;
  VectorResponseOptions: new () => Vector<ResponseOptions>;
}

/** The 8-bit matrix routines the module imports, and the names it exports its own versions of them under. */
const GEMM: Record<string, string> = {
  int8_prepare_a: 'int8PrepareAFallback',
  int8_prepare_b: 'int8PrepareBFallback',
  int8_prepare_b_from_transposed: 'int8PrepareBFromTransposedFallback',
  int8_prepare_b_from_quantized_transposed: 'int8PrepareBFromQuantizedTransposedFallback',
  int8_prepare_bias: 'int8PrepareBiasFallback',
  int8_multiply_and_add_bias: 'int8MultiplyAndAddBiasFallback',
  int8_select_columns_of_b: 'int8SelectColumnsOfBFallback',
};

/** How the models are run: as Firefox runs them (one best answer, 8-bit arithmetic), without the parts a reader does not need. */
const MODEL_CONFIG = [
  'beam-size: 1',
  'normalize: 1.0',
  'word-penalty: 0',
  'cpu-threads: 0',
  'gemm-precision: int8shiftAlphaAll',
  'skip-cost: true',
  'alignment: soft',
  'quiet: true',
  'quiet-translation: true',
  'max-length-break: 128',
  'mini-batch-words: 1024',
  'workspace: 128',
  'max-length-factor: 2.0',
  '',
].join('\n');

const GLUE = 'bergamot-translator-worker.js';
const WASM = 'bergamot-translator-worker.wasm';

function loadModule(engineDir: string): Promise<BergamotModule> {
  const glue = readFileSync(join(engineDir, GLUE), 'utf8');
  const wasm = readFileSync(join(engineDir, WASM));
  return new Promise((resolve, reject) => {
    const module = {
      print: () => undefined,
      printErr: () => undefined,
      onAbort: (what: unknown) => reject(new Error(`The translator stopped: ${String(what)}`)),
      instantiateWasm(info: WebAssembly.Imports, accept: (instance: WebAssembly.Instance) => void): object {
        const fallback = Object.fromEntries(Object.entries(GEMM).map(([name, own]) => [name, (...args: number[]) => (module as unknown as BergamotModule).asm[own](...args)]));
        WebAssembly.instantiate(wasm, { ...info, wasm_gemm: fallback })
          .then(({ instance }) => accept(instance))
          .catch(reject);
        return {};
      },
      onRuntimeInitialized: () => resolve(module as unknown as BergamotModule),
    };
    try {
      // Emscripten's glue code is a script that fills in a `Module` object it finds in its scope.
      // It is a file of this extension (never anything downloaded), run in this worker thread.
      const run = new Function('Module', 'require', '__dirname', '__filename', glue) as (...args: unknown[]) => void;
      run(module, require, engineDir, join(engineDir, GLUE));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export interface ModelFiles {
  model: string;
  shortlist?: string;
  vocabs: string[];
}

export class Engine {
  private readonly models = new Map<string, Deletable>();
  private readonly service: Service;

  private constructor(private readonly module: BergamotModule) {
    this.service = new module.BlockingService({ cacheSize: 0 });
  }

  /** `engineDir`: the folder the two files of the engine are in. */
  static async load(engineDir: string): Promise<Engine> {
    return new Engine(await loadModule(engineDir));
  }

  private aligned(path: string, alignment: number): AlignedMemory {
    const bytes = readFileSync(path);
    const memory = new this.module.AlignedMemory(bytes.byteLength, alignment);
    memory.getByteArrayView().set(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return memory;
  }

  has(key: string): boolean {
    return this.models.has(key);
  }

  /** Loads the model of one direction from its files, under `key`. */
  loadModel(key: string, files: ModelFiles): void {
    if (this.models.has(key)) return;
    const vocabs = new this.module.AlignedMemoryList();
    for (const vocab of files.vocabs) vocabs.push_back(this.aligned(vocab, 64));
    const model = new this.module.TranslationModel(MODEL_CONFIG, this.aligned(files.model, 256), files.shortlist ? this.aligned(files.shortlist, 64) : null, vocabs, null);
    this.models.set(key, model);
  }

  /** Translates a text with one model, or with two, one after the other (by way of the language they share). */
  translate(keys: string[], text: string): string {
    const models = keys.map((key) => {
      const model = this.models.get(key);
      if (!model) throw new Error(`The language pack ${key} is not loaded.`);
      return model;
    });
    if (models.length < 1 || models.length > 2) throw new Error('A translation takes one language pack, or two.');
    const input = new this.module.VectorString();
    const options = new this.module.VectorResponseOptions();
    input.push_back(text);
    options.push_back({ alignment: false, html: false, qualityScores: false });
    try {
      const responses = models.length === 2 ? this.service.translateViaPivoting(models[0], models[1], input, options) : this.service.translate(models[0], input, options);
      try {
        return responses.get(0).getTranslatedText();
      } finally {
        responses.delete();
      }
    } finally {
      input.delete();
      options.delete();
    }
  }

  /** The memory the WebAssembly module holds, in bytes (it grows with use and is given back only when the worker ends). */
  get heapBytes(): number {
    return this.module.HEAP8.length;
  }
}
