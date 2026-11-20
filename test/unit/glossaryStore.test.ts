// The glossary of each document is kept on disk next to its annotations, in a file of its own,
// and comes back with them from the backup.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TERMS, type GlossaryTerm } from '../../src/shared/glossary';
import { copyFolderFromFirst } from '../../src/store/atomicWrite';
import { ANNOTATIONS_FOLDER, Backup } from '../../src/store/Backup';
import { GlossaryStore, glossaryFileText, putTerms, sanitizeGlossaryFile } from '../../src/store/GlossaryStore';
import { HighlightStore, recordKey, type DocumentRef } from '../../src/store/HighlightStore';
import { makeHighlight } from './helpers';

const AT = '2026-11-19T10:00:00.000Z';
const ref = (path: string): DocumentRef => ({ uri: `file://${path}`, scheme: 'file', fsPath: path });
const A = ref('/docs/a.md');
const B = ref('/docs/b.md');
const key = (r: DocumentRef) => recordKey(r, 'linux');
const term = (id: string, text: string, definition = `what ${text} means`): GlossaryTerm => ({ id, term: text, definition, createdAt: AT, updatedAt: AT });
const names = (terms: GlossaryTerm[]) => terms.map((t) => `${t.term}=${t.definition}`).sort();

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'reading-room-glossary-')), ANNOTATIONS_FOLDER);
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

function open(changed?: (key: string) => void): GlossaryStore {
  return new GlossaryStore({ dir, keyOf: key, platform: 'linux', coalesceMs: 5, onFilesChanged: changed });
}
const file = (r: DocumentRef) => join(dir, `${key(r)}.glossary.json`);
const read = (r: DocumentRef) => JSON.parse(readFileSync(file(r), 'utf8')) as { schemaVersion: number; uri: string; fsPath?: string; terms: GlossaryTerm[] };

describe('putting terms into a glossary', () => {
  it('a new version of a term takes its place and keeps when it was made', () => {
    const list = [{ ...term('a', 'MLP'), createdAt: '2026-01-01T00:00:00.000Z' }];
    expect(putTerms(list, [{ ...term('a', 'MLP', 'Multi-Layer Perceptron'), createdAt: 'later' }])).toBe(0);
    expect(list).toEqual([{ ...term('a', 'MLP', 'Multi-Layer Perceptron'), createdAt: '2026-01-01T00:00:00.000Z' }]);
  });

  it('a document has one definition per term: another one with its key gives way', () => {
    const list = [term('a', 'ReLU', 'old'), term('b', 'MLP')];
    putTerms(list, [term('c', 'relu', 'new')]);
    expect(list.map((t) => `${t.id}:${t.term}`)).toEqual(['c:relu', 'b:MLP']);
    // A term renamed to what another one is called takes that one's place too.
    putTerms(list, [term('b', 'Relu', 'renamed')]);
    expect(list.map((t) => `${t.id}:${t.term}`)).toEqual(['b:Relu']);
    // (In capitals only it is another term: it is found in other places.)
    putTerms(list, [term('d', 'RELU')]);
    expect(list.map((t) => `${t.id}:${t.term}`)).toEqual(['b:Relu', 'd:RELU']);
  });

  it('refuses terms beyond what a document can have', () => {
    const list = Array.from({ length: MAX_TERMS }, (_, i) => term(`t${i}`, `term${i}`));
    expect(putTerms(list, [term('new', 'one more'), term('t3', 'term3', 'changed')])).toBe(1);
    expect(list).toHaveLength(MAX_TERMS);
    expect(list[3].definition).toBe('changed');
  });
});

describe('GlossaryStore', () => {
  it('a document without a glossary has no terms and no file', async () => {
    const store = open();
    expect(await store.get(A)).toEqual([]);
    expect(await store.isReadOnly(A)).toBe(false);
    await store.flush();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('stores terms in a file of the document, and reads them back', async () => {
    const changed: string[] = [];
    const store = open((k) => changed.push(k));
    expect(await store.save(A, [term('a', 'MLP', 'Multi-Layer Perceptron'), term('b', 'ReLU')])).toBe(0);
    await store.flush();
    const stored = read(A);
    expect(stored.schemaVersion).toBe(1);
    expect(stored.uri).toBe(A.uri);
    expect(stored.fsPath).toBe(A.fsPath);
    expect(names(stored.terms)).toEqual(['MLP=Multi-Layer Perceptron', 'ReLU=what ReLU means']);
    // The backup hears of the write, under the key of the document.
    expect(changed).toEqual([key(A)]);
    // Another session reads the same terms.
    expect(names(await open().get(A))).toEqual(['MLP=Multi-Layer Perceptron', 'ReLU=what ReLU means']);
    // Each document has its own.
    expect(await open().get(B)).toEqual([]);
  });

  it('what it gives is a copy: changing it changes nothing that is stored', async () => {
    const store = open();
    await store.save(A, [term('a', 'MLP')]);
    const got = await store.get(A);
    got[0].definition = 'changed outside';
    expect((await store.get(A))[0].definition).toBe('what MLP means');
  });

  it('changes a term, and stamps when', async () => {
    const store = open();
    await store.save(A, [term('a', 'MLP', 'first')]);
    await store.save(A, [term('a', 'MLP', 'second')]);
    await store.flush();
    const [stored] = read(A).terms;
    expect(stored.definition).toBe('second');
    expect(stored.createdAt).toBe(AT);
    expect(stored.updatedAt > AT).toBe(true);
  });

  it('deletes terms, and removes the file with the last one', async () => {
    const changed: string[] = [];
    const store = open((k) => changed.push(k));
    await store.save(A, [term('a', 'MLP'), term('b', 'ReLU')]);
    await store.flush();
    expect(await store.removeTerms(A, ['a', 'not-there'])).toBe(1);
    await store.flush();
    expect(names(read(A).terms)).toEqual(['ReLU=what ReLU means']);
    expect(await store.removeTerms(A, ['b'])).toBe(1);
    await store.flush();
    expect(existsSync(file(A))).toBe(false);
    expect(changed).toEqual([key(A), key(A), key(A)]);
    expect(await open().get(A)).toEqual([]);
  });

  it('leaves a glossary of a newer version alone', async () => {
    const newer = JSON.stringify({ schemaVersion: 2, uri: A.uri, terms: [{ id: 'a', what: 'something this version does not know' }] });
    writeFileSync(file(A), newer);
    const store = open();
    expect(await store.get(A)).toEqual([]);
    expect(await store.isReadOnly(A)).toBe(true);
    expect(await store.save(A, [term('a', 'MLP')])).toBe(0);
    expect(await store.removeTerms(A, ['a'])).toBe(0);
    expect(await store.mergeInto([term('b', 'ReLU')], A)).toBe(0);
    await store.flush();
    expect(readFileSync(file(A), 'utf8')).toBe(newer);
    // It is not offered to other documents either: what it holds cannot be read.
    expect(await store.list()).toEqual([]);
  });

  it('keeps a file that cannot be read under another name, and starts an empty glossary', async () => {
    writeFileSync(file(A), '{ "terms": [ {"id": "a", "term": "MLP", "definition": "Multi');
    const changed: string[] = [];
    const store = open((k) => changed.push(k));
    expect(await store.get(A)).toEqual([]);
    expect(await store.isReadOnly(A)).toBe(false);
    const aside = readdirSync(dir).filter((name) => name.startsWith(`${key(A)}.glossary.unreadable-`));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]), 'utf8')).toContain('"MLP"');
    expect(changed).toEqual([key(A)]);
    await store.save(A, [term('b', 'ReLU')]);
    await store.flush();
    expect(names(read(A).terms)).toEqual(['ReLU=what ReLU means']);
  });

  it('drops what is not a term when it reads a file', () => {
    const content = sanitizeGlossaryFile({ schemaVersion: 1, uri: A.uri, fsPath: 7, terms: [term('a', 'MLP'), { id: 'b' }, 'x', term('a', 'again')] });
    expect(content.uri).toBe(A.uri);
    expect(content.fsPath).toBeUndefined();
    expect(content.terms.map((t) => t.term)).toEqual(['MLP']);
    expect(sanitizeGlossaryFile(null)).toEqual({ terms: [], readOnly: false });
    expect(sanitizeGlossaryFile([1, 2])).toEqual({ terms: [], readOnly: false });
    expect(glossaryFileText(A, [])).toBeUndefined();
  });

  it('forgets a document whose viewer closed, unless a change is still to be written', async () => {
    const store = open();
    await store.save(A, [term('a', 'MLP')]);
    store.evict(A);
    await store.flush();
    expect(names(read(A).terms)).toEqual(['MLP=what MLP means']);
    store.evict(A);
    // Changed by another window meanwhile: read again after it was forgotten.
    writeFileSync(file(A), glossaryFileText(A, [term('z', 'CNN')]) ?? '');
    expect(names(await store.get(A))).toEqual(['CNN=what CNN means']);
  });

  it('reads the file again on request', async () => {
    const store = open();
    await store.save(A, [term('a', 'MLP')]);
    await store.flush();
    writeFileSync(file(A), glossaryFileText(A, [term('a', 'MLP'), term('z', 'CNN')]) ?? '');
    expect(names(await store.get(A))).toEqual(['MLP=what MLP means']);
    expect(names(await store.reload(A))).toEqual(['CNN=what CNN means', 'MLP=what MLP means']);
  });
});

describe('two windows', () => {
  it('terms defined in another window meanwhile are kept', async () => {
    const here = open();
    const there = open();
    await here.save(A, [term('a', 'MLP')]);
    await here.flush();
    expect(names(await there.get(A))).toEqual(['MLP=what MLP means']);
    await there.save(A, [term('b', 'ReLU')]);
    await there.flush();
    // This window did not see ReLU, and defines CNN.
    await here.save(A, [term('c', 'CNN')]);
    await here.flush();
    expect(names(read(A).terms)).toEqual(['CNN=what CNN means', 'MLP=what MLP means', 'ReLU=what ReLU means']);
    expect(names(await here.get(A))).toEqual(['CNN=what CNN means', 'MLP=what MLP means', 'ReLU=what ReLU means']);
  });

  it('of two versions of a term, the one changed last stays', async () => {
    const here = open();
    const there = open();
    await here.save(A, [term('a', 'MLP', 'first')]);
    await here.flush();
    await there.get(A);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await there.save(A, [term('a', 'MLP', 'changed in the other window')]);
    await there.flush();
    await here.save(A, [term('b', 'ReLU')]);
    await here.flush();
    expect(names(read(A).terms)).toEqual(['MLP=changed in the other window', 'ReLU=what ReLU means']);
  });

  /** A window that writes only when it is told to (so the test decides which of the two writes first). */
  const slow = () => new GlossaryStore({ dir, keyOf: key, platform: 'linux', coalesceMs: 60_000 });

  it('a term deleted here is not brought back by the other window, when the other window writes first', async () => {
    const here = slow();
    const there = slow();
    await here.save(A, [term('a', 'MLP'), term('b', 'ReLU')]);
    await here.flush();
    await there.get(A);
    await here.removeTerms(A, ['a']);
    await there.save(A, [term('c', 'CNN')]);
    await there.flush();
    expect(names(read(A).terms)).toEqual(['CNN=what CNN means', 'MLP=what MLP means', 'ReLU=what ReLU means']);
    await here.flush();
    expect(names(read(A).terms)).toEqual(['CNN=what CNN means', 'ReLU=what ReLU means']);
  });

  it('nor when this window writes first: the other window sees that the term is gone', async () => {
    const here = slow();
    const there = slow();
    await here.save(A, [term('a', 'MLP'), term('b', 'ReLU')]);
    await here.flush();
    await there.get(A);
    await here.removeTerms(A, ['a']);
    await there.save(A, [term('c', 'CNN')]);
    await here.flush();
    expect(names(read(A).terms)).toEqual(['ReLU=what ReLU means']);
    await there.flush();
    expect(names(read(A).terms)).toEqual(['CNN=what CNN means', 'ReLU=what ReLU means']);
    expect(names(await there.get(A))).toEqual(['CNN=what CNN means', 'ReLU=what ReLU means']);
  });

  it('a term the other window deleted stays here if it was changed here since', async () => {
    const here = slow();
    const there = slow();
    await here.save(A, [term('a', 'MLP'), term('b', 'ReLU')]);
    await here.flush();
    await there.get(A);
    await here.removeTerms(A, ['a']);
    await here.flush();
    await there.save(A, [term('a', 'MLP', 'changed after the other window deleted it')]);
    await there.flush();
    expect(names(read(A).terms)).toEqual(['MLP=changed after the other window deleted it', 'ReLU=what ReLU means']);
  });

  it('the other window deleted the last term: what was not changed here goes too', async () => {
    const here = slow();
    const there = slow();
    await here.save(A, [term('a', 'MLP')]);
    await here.flush();
    await there.get(A);
    await here.removeTerms(A, ['a']);
    await here.flush();
    expect(existsSync(file(A))).toBe(false);
    await there.save(A, [term('c', 'CNN')]);
    await there.flush();
    expect(names(read(A).terms)).toEqual(['CNN=what CNN means']);
  });
});

describe('renames', () => {
  it('the terms follow a renamed document', async () => {
    const changed: string[] = [];
    const store = open((k) => changed.push(k));
    await store.save(A, [term('a', 'MLP')]);
    await store.flush();
    changed.length = 0;
    await store.migrate(A, B);
    expect(existsSync(file(A))).toBe(false);
    const stored = read(B);
    expect(stored.uri).toBe(B.uri);
    expect(stored.fsPath).toBe(B.fsPath);
    expect(names(stored.terms)).toEqual(['MLP=what MLP means']);
    expect(await store.get(A)).toEqual([]);
    expect(names(await store.get(B))).toEqual(['MLP=what MLP means']);
    // Both documents changed for the backup.
    expect(new Set(changed)).toEqual(new Set([key(A), key(B)]));
  });

  it('joins the glossary of a document that takes the place of another: the definitions that were there stay', async () => {
    const store = open();
    await store.save(A, [term('a', 'MLP', 'from the renamed file'), term('b', 'ReLU', 'only in the renamed file')]);
    await store.save(B, [term('x', 'mlp'), term('c', 'MLP', 'what was there')]);
    await store.flush();
    await store.migrate(A, B);
    expect(names(read(B).terms)).toEqual(['MLP=what was there', 'ReLU=only in the renamed file', 'mlp=what mlp means']);
    expect(existsSync(file(A))).toBe(false);
  });

  it('moves a term that is still to be written', async () => {
    const store = open();
    await store.save(A, [term('a', 'MLP')]);
    await store.migrate(A, B);
    expect(names(read(B).terms)).toEqual(['MLP=what MLP means']);
  });

  it('does nothing for a document without a glossary, or renamed to itself', async () => {
    const store = open();
    await store.migrate(A, B);
    expect(readdirSync(dir)).toEqual([]);
    await store.save(A, [term('a', 'MLP')]);
    await store.migrate(A, A);
    await store.flush();
    expect(names(read(A).terms)).toEqual(['MLP=what MLP means']);
  });

  it('the glossaries of the documents of a renamed folder follow, the others stay', async () => {
    const store = open();
    const inside = ref('/work/papers/attention.pdf');
    const deeper = ref('/work/papers/notes/day.md');
    const outside = ref('/work/papers-old/x.md');
    await store.save(inside, [term('a', 'MLP')]);
    await store.save(deeper, [term('b', 'ReLU')]);
    await store.save(outside, [term('c', 'CNN')]);
    await store.flush();
    expect(await store.migrateFolder(ref('/work/papers'), ref('/work/reading'), ref)).toBe(2);
    expect(names(await store.get(ref('/work/reading/attention.pdf')))).toEqual(['MLP=what MLP means']);
    expect(names(await store.get(ref('/work/reading/notes/day.md')))).toEqual(['ReLU=what ReLU means']);
    expect(names(await store.get(outside))).toEqual(['CNN=what CNN means']);
    expect(existsSync(file(inside))).toBe(false);
    expect(existsSync(file(deeper))).toBe(false);
    expect(read(ref('/work/reading/attention.pdf')).fsPath).toBe('/work/reading/attention.pdf');
  });
});

describe('every term the reader defined', () => {
  it('lists the glossary of every document, with the document it is for', async () => {
    const store = open();
    await store.save(A, [term('a', 'MLP', 'Multi-Layer Perceptron')]);
    await store.save(B, [term('b', 'MLP', 'Maximum Likelihood Probability'), term('c', 'ReLU')]);
    // (Not written yet: listing writes what is pending first.)
    const listed = await store.list();
    expect(listed.map((g) => `${g.fsPath}: ${names(g.terms).join(', ')}`).sort()).toEqual([
      '/docs/a.md: MLP=Multi-Layer Perceptron',
      '/docs/b.md: MLP=Maximum Likelihood Probability, ReLU=what ReLU means',
    ]);
    expect(listed.find((g) => g.fsPath === '/docs/a.md')?.key).toBe(key(A));
    // A session that has none of them open reads the same from the files.
    expect((await open().list()).map((g) => g.uri).sort()).toEqual([A.uri, B.uri]);
  });

  it('leaves out documents without terms, and files that are not glossaries', async () => {
    const store = open();
    await store.save(A, [term('a', 'MLP')]);
    await store.flush();
    await store.removeTerms(A, ['a']);
    writeFileSync(join(dir, `${key(B)}.json`), '{"schemaVersion":1}');
    writeFileSync(join(dir, `${key(B)}.history.json`), '{}');
    writeFileSync(join(dir, 'notes.glossary.json'), '{}');
    expect(await store.list()).toEqual([]);
  });

  it('lists nothing when there is no folder yet', async () => {
    const store = new GlossaryStore({ dir: join(dir, 'missing'), keyOf: key });
    expect(await store.list()).toEqual([]);
  });

  it('copies the terms a document does not define itself', async () => {
    const store = open();
    await store.save(B, [term('x', 'MLP', 'its own meaning')]);
    expect(await store.mergeInto([term('a', 'mlp'), term('b', 'MLP', 'another meaning'), term('c', 'ReLU'), term('d', 'relu')], B)).toBe(2);
    await store.flush();
    expect(names(read(B).terms)).toEqual(['MLP=its own meaning', 'ReLU=what ReLU means', 'mlp=what mlp means']);
  });
});

describe('with the annotations and the backup', () => {
  function session(storage: string, backupDir: string) {
    const folder = join(storage, ANNOTATIONS_FOLDER);
    const backup = new Backup({ source: folder, target: join(backupDir, ANNOTATIONS_FOLDER), delayMs: 5 });
    const changed = (k: string) => backup.changed(k);
    const glossary: GlossaryStore = new GlossaryStore({ dir: folder, keyOf: (r) => store.keyOf(r), platform: 'linux', coalesceMs: 5, onFilesChanged: changed });
    const store: HighlightStore = new HighlightStore({
      dir: folder,
      platform: 'linux',
      coalesceMs: 5,
      onFilesChanged: changed,
      onMigrate: (from, to) => glossary.migrate(from, to),
    });
    const close = async () => {
      await store.flush();
      await glossary.flush();
      await backup.flush();
    };
    return { store, glossary, backup, folder, close };
  }
  const listed = (folder: string) => (existsSync(folder) ? readdirSync(folder).sort() : []);

  it('the glossary is copied to the backup, and comes back after the storage folder was deleted', async () => {
    const root = join(dir, '..');
    const storage = join(root, 'storage');
    const backupDir = join(root, 'backup');
    const before = session(storage, backupDir);
    await before.store.update(A, (r) => r.highlights.push(makeHighlight('kept through an uninstall')));
    await before.glossary.save(A, [term('a', 'MLP', 'Multi-Layer Perceptron')]);
    // A document with a glossary and nothing else is kept too.
    await before.glossary.save(B, [term('b', 'ReLU')]);
    await before.close();
    const copied = listed(join(backupDir, ANNOTATIONS_FOLDER));
    expect(copied).toEqual(listed(before.folder));
    expect(copied).toContain(`${key(A)}.glossary.json`);
    expect(copied).toContain(`${key(B)}.glossary.json`);

    // VS Code deletes the storage folder of an uninstalled extension; a new install starts from the backup.
    rmSync(storage, { recursive: true, force: true });
    expect(copyFolderFromFirst([backupDir], storage, ANNOTATIONS_FOLDER)).toBe(backupDir);
    const after = session(storage, backupDir);
    expect(names(await after.glossary.get(A))).toEqual(['MLP=Multi-Layer Perceptron']);
    expect(names(await after.glossary.get(B))).toEqual(['ReLU=what ReLU means']);
    expect((await after.glossary.list()).map((g) => g.fsPath).sort()).toEqual(['/docs/a.md', '/docs/b.md']);
    await after.close();
  });

  it('a deleted glossary leaves the backup too', async () => {
    const root = join(dir, '..');
    const s = session(join(root, 'storage'), join(root, 'backup'));
    await s.glossary.save(A, [term('a', 'MLP')]);
    await s.close();
    expect(listed(join(root, 'backup', ANNOTATIONS_FOLDER))).toEqual([`${key(A)}.glossary.json`]);
    await s.glossary.removeTerms(A, ['a']);
    await s.close();
    expect(listed(join(root, 'backup', ANNOTATIONS_FOLDER))).toEqual([]);
  });

  it('a renamed document takes its glossary along with its annotations, in the backup too', async () => {
    const root = join(dir, '..');
    const s = session(join(root, 'storage'), join(root, 'backup'));
    await s.store.update(A, (r) => r.highlights.push(makeHighlight('moves with the file')));
    await s.glossary.save(A, [term('a', 'MLP')]);
    await s.close();
    expect(await s.store.migrate(A, B)).toBe(true);
    await s.close();
    expect(listed(s.folder).every((name) => name.startsWith(key(B)))).toBe(true);
    expect(listed(s.folder)).toContain(`${key(B)}.glossary.json`);
    expect(listed(join(root, 'backup', ANNOTATIONS_FOLDER))).toEqual(listed(s.folder));
    expect(names(await s.glossary.get(B))).toEqual(['MLP=what MLP means']);
  });

  it('a renamed document that has only a glossary takes it along too', async () => {
    const root = join(dir, '..');
    const s = session(join(root, 'storage'), join(root, 'backup'));
    await s.glossary.save(A, [term('a', 'MLP')]);
    await s.close();
    // (No annotations to move: the store says so, and the glossary moved all the same.)
    expect(await s.store.migrate(A, B)).toBe(false);
    await s.close();
    expect(listed(s.folder)).toEqual([`${key(B)}.glossary.json`]);
    expect(listed(join(root, 'backup', ANNOTATIONS_FOLDER))).toEqual(listed(s.folder));
  });
});
