// Makes src/translate/models.json: the list of language packs the translate tool offers, from
// Mozilla's registry of translation models (the ones Firefox translates pages with).
//
// For every direction the registry has a released model for, the list keeps where its files are,
// the SHA-256 of the model, and the size of the download (asked from the server, file by file).
// The list is shipped with the extension, so nothing is asked from any server before the reader
// agreed to download a pack. Run it to pick up new languages and retrained models:
//   npm run translation-models
import * as esbuild from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The rules that pick a model are the extension's own (src/translate/registry.ts).
const built = await esbuild.build({ entryPoints: [join(root, 'src/translate/registry.ts')], bundle: true, format: 'esm', platform: 'node', write: false });
const registry = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const response = await fetch(registry.REGISTRY_URL);
if (!response.ok) throw new Error(`${registry.REGISTRY_URL}: ${response.status}`);
const list = registry.packsOfRegistry(await response.json(), new Date().toISOString().slice(0, 10));
const packs = Object.values(list.packs);

async function sizeOf(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const head = await fetch(`${registry.MODELS_BASE_URL}/${path}`, { method: 'HEAD' });
      const length = Number(head.headers.get('content-length'));
      if (!head.ok || !Number.isFinite(length) || length <= 0) throw new Error(`${path}: ${head.status}`);
      return length;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

let next = 0;
async function worker() {
  while (next < packs.length) {
    const pack = packs[next++];
    const files = [pack.model, ...(pack.shortlist ? [pack.shortlist] : []), ...pack.vocabs];
    const sizes = await Promise.all(files.map((file) => sizeOf(file.path)));
    pack.bytes = sizes.reduce((sum, size) => sum + size, 0);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

const target = join(root, 'src/translate/models.json');
await writeFile(target, `${JSON.stringify(list, null, 1)}\n`);
const total = packs.reduce((sum, pack) => sum + pack.bytes, 0);
console.log(`${packs.length} language packs, ${Math.round(total / 1e6)} MB in all, written to ${target}`);
