// The annotations are also kept outside VS Code's storage, which VS Code deletes on uninstall,
// and come back from there when the extension starts with nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFolderFromFirst } from '../../src/store/atomicWrite';
import { ANNOTATIONS_FOLDER, Backup, backupRoot } from '../../src/store/Backup';
import { HighlightStore, type DocumentRef } from '../../src/store/HighlightStore';
import { HistoryStore } from '../../src/store/HistoryStore';
import { makeDrawing, makeHighlight } from './helpers';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

let root: string;
let source: string;
let target: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reading-room-backup-'));
  source = join(root, 'storage', ANNOTATIONS_FOLDER);
  target = join(root, 'backup', ANNOTATIONS_FOLDER);
  mkdirSync(source, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (dir: string, name: string, text: string) => writeFileSync(join(dir, name), text);
const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe('where the backup is', () => {
  it('is in the application data of the platform, outside of VS Code', () => {
    expect(backupRoot('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me')).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'Reading Room', 'backup'));
    expect(backupRoot('win32', {}, 'C:\\Users\\me')).toBe(join('C:\\Users\\me', 'AppData', 'Roaming', 'Reading Room', 'backup'));
    expect(backupRoot('darwin', {}, '/Users/me')).toBe(join('/Users/me', 'Library', 'Application Support', 'Reading Room', 'backup'));
    expect(backupRoot('linux', {}, '/home/me')).toBe(join('/home/me', '.local', 'share', 'reading-room', 'backup'));
    expect(backupRoot('linux', { XDG_DATA_HOME: '/data' }, '/home/me')).toBe(join('/data', 'reading-room', 'backup'));
  });
});

describe('Backup', () => {
  it('copies everything that is not there yet when it starts', async () => {
    put(source, `${A}.json`, 'one');
    put(source, `${A}.text-0123456789.gz`, 'snapshot');
    put(source, `${B}.drawings.json`, 'two');
    const backup = new Backup({ source, target });
    expect(await backup.prime()).toBe(3);
    expect(list(target)).toEqual(list(source));
    expect(readFileSync(join(target, `${A}.json`), 'utf8')).toBe('one');
    // Nothing changed: nothing is copied again.
    expect(await backup.prime()).toBe(0);
  });

  it('copies a file again when it changed', async () => {
    put(source, `${A}.json`, 'one');
    const backup = new Backup({ source, target });
    await backup.prime();
    put(source, `${A}.json`, 'two!');
    expect(await backup.prime()).toBe(1);
    expect(readFileSync(join(target, `${A}.json`), 'utf8')).toBe('two!');
    // The same size, written later than the copy.
    put(source, `${A}.json`, 'six!');
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(source, `${A}.json`), later, later);
    expect(await backup.prime()).toBe(1);
    expect(readFileSync(join(target, `${A}.json`), 'utf8')).toBe('six!');
  });

  it('removes nothing when it starts: only a change of a document removes its files', async () => {
    mkdirSync(target, { recursive: true });
    put(target, `${B}.json`, 'made in another editor');
    put(source, `${A}.json`, 'one');
    await new Backup({ source, target }).prime();
    expect(list(target)).toEqual([`${A}.json`, `${B}.json`]);
  });

  it('follows the files of a document that changed', async () => {
    put(source, `${A}.json`, 'one');
    put(source, `${A}.anchors.json`, 'anchors');
    put(source, `${B}.json`, 'other');
    const backup = new Backup({ source, target, delayMs: 5 });
    await backup.prime();
    put(source, `${A}.json`, 'one, changed');
    put(source, `${A}.history.json`, 'history');
    rmSync(join(source, `${A}.anchors.json`));
    backup.changed(A);
    await backup.flush();
    expect(list(target)).toEqual([`${A}.history.json`, `${A}.json`, `${B}.json`]);
    expect(readFileSync(join(target, `${A}.json`), 'utf8')).toBe('one, changed');
  });

  it('removes the copy of a document whose annotations were all deleted', async () => {
    put(source, `${A}.json`, 'one');
    put(source, `${B}.json`, 'other');
    const backup = new Backup({ source, target, delayMs: 5 });
    await backup.prime();
    rmSync(join(source, `${A}.json`));
    backup.changed(A);
    await backup.flush();
    expect(list(target)).toEqual([`${B}.json`]);
  });

  it('does not copy files that are being written', async () => {
    put(source, `${A}.json`, 'one');
    put(source, `${A}.json.tmp-123-abcd`, 'half');
    const backup = new Backup({ source, target, delayMs: 5 });
    await backup.prime();
    backup.changed(A);
    await backup.flush();
    expect(list(target)).toEqual([`${A}.json`]);
  });

  it('copies nothing while it is turned off, and catches up when it is turned on', async () => {
    let enabled = false;
    put(source, `${A}.json`, 'one');
    const backup = new Backup({ source, target, delayMs: 5, enabled: () => enabled });
    expect(await backup.prime()).toBe(0);
    backup.changed(A);
    await backup.flush();
    expect(list(target)).toEqual([]);
    enabled = true;
    expect(await backup.prime()).toBe(1);
    expect(list(target)).toEqual([`${A}.json`]);
  });

  it('a document that cannot be copied does not keep the others from being copied, and is tried again', async () => {
    put(source, `${A}.json`, 'one');
    put(source, `${B}.json`, 'other');
    // A folder where the copy of a file should be.
    mkdirSync(join(target, `${A}.json`), { recursive: true });
    writeFileSync(join(target, `${A}.json`, 'in the way'), 'x');
    const warnings: string[] = [];
    const log = { info: () => undefined, warn: (m: string) => warnings.push(m), error: () => undefined };
    const backup = new Backup({ source, target, delayMs: 5, log });
    backup.changed(A);
    backup.changed(B);
    await backup.flush();
    expect(readFileSync(join(target, `${B}.json`), 'utf8')).toBe('other');
    expect(warnings).toHaveLength(1);
    rmSync(join(target, `${A}.json`), { recursive: true });
    // The next change of any document takes the one that failed along.
    backup.changed(B);
    await backup.flush();
    expect(readFileSync(join(target, `${A}.json`), 'utf8')).toBe('one');
  });

  it('never fails: a backup that cannot be written is logged once', async () => {
    put(source, `${A}.json`, 'one');
    // A file where the backup folder should be.
    mkdirSync(join(root, 'backup'));
    writeFileSync(target, 'in the way');
    const warnings: string[] = [];
    const log = { info: () => undefined, warn: (m: string) => warnings.push(m), error: () => undefined };
    const backup = new Backup({ source, target, delayMs: 5, log });
    await expect(backup.prime()).resolves.toBe(0);
    backup.changed(A);
    await expect(backup.flush()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});

describe('with the stores', () => {
  const ref: DocumentRef = { uri: 'file:///docs/a.md', scheme: 'file', fsPath: '/docs/a.md' };

  function open(storage: string, backupDir: string) {
    const dir = join(storage, ANNOTATIONS_FOLDER);
    const backup = new Backup({ source: dir, target: join(backupDir, ANNOTATIONS_FOLDER), delayMs: 5 });
    const store = new HighlightStore({ dir, platform: 'linux', coalesceMs: 5, onFilesChanged: (key) => backup.changed(key) });
    const history = new HistoryStore({ dir, keyOf: (r) => store.keyOf(r), coalesceMs: 5, onFilesChanged: (key) => backup.changed(key) });
    const close = async () => {
      await store.flush();
      await history.flush();
      await backup.flush();
    };
    return { store, history, backup, close };
  }

  it('the annotations and the undo history come back after the storage folder was deleted', async () => {
    const storage = join(root, 'storage');
    const backupDir = join(root, 'backup');
    const highlight = makeHighlight('kept through an uninstall');
    const drawing = makeDrawing();

    const before = open(storage, backupDir);
    await before.store.update(ref, (r) => {
      r.highlights.push(highlight);
      r.drawings.push(drawing);
    });
    await before.history.change(ref, { kind: 'push', step: { op: { kind: 'create', highlight }, label: 'Highlight' } });
    await before.close();
    expect(list(join(backupDir, ANNOTATIONS_FOLDER))).toEqual(list(join(storage, ANNOTATIONS_FOLDER)));

    // VS Code deletes the storage folder of an uninstalled extension.
    rmSync(storage, { recursive: true, force: true });
    // A new install starts with nothing: the annotations folder comes back from the backup.
    expect(copyFolderFromFirst([join(root, 'no-earlier-id'), backupDir], storage, ANNOTATIONS_FOLDER)).toBe(backupDir);

    const after = open(storage, backupDir);
    const record = await after.store.get(ref);
    expect(record.highlights.map((h) => h.id)).toEqual([highlight.id]);
    expect(record.drawings.map((d) => d.id)).toEqual([drawing.id]);
    expect((await after.history.get(ref)).done.map((s) => s.label)).toEqual(['Highlight']);
    await after.close();
  });

  it('a folder that is there with nothing in it counts as a new install too', async () => {
    const storage = join(root, 'storage');
    const backupDir = join(root, 'backup');
    mkdirSync(join(backupDir, ANNOTATIONS_FOLDER), { recursive: true });
    put(join(backupDir, ANNOTATIONS_FOLDER), `${A}.json`, 'one');
    expect(list(source)).toEqual([]);
    expect(copyFolderFromFirst([backupDir], storage, ANNOTATIONS_FOLDER)).toBe(backupDir);
    expect(list(source)).toEqual([`${A}.json`]);
  });

  it('a backup with nothing in it brings nothing back, and annotations that are there are never replaced', async () => {
    const storage = join(root, 'storage');
    const backupDir = join(root, 'backup');
    mkdirSync(join(backupDir, ANNOTATIONS_FOLDER), { recursive: true });
    expect(copyFolderFromFirst([backupDir], storage, ANNOTATIONS_FOLDER)).toBeUndefined();
    put(join(backupDir, ANNOTATIONS_FOLDER), `${A}.json`, 'old');
    put(source, `${B}.json`, 'mine');
    expect(copyFolderFromFirst([backupDir], storage, ANNOTATIONS_FOLDER)).toBeUndefined();
    expect(list(source)).toEqual([`${B}.json`]);
  });

  it('a renamed document takes its undo history along, in the backup too', async () => {
    const storage = join(root, 'storage');
    const backupDir = join(root, 'backup');
    const dir = join(storage, ANNOTATIONS_FOLDER);
    const backup = new Backup({ source: dir, target: join(backupDir, ANNOTATIONS_FOLDER), delayMs: 5 });
    const changed = (key: string) => backup.changed(key);
    const moved: DocumentRef = { uri: 'file:///docs/b.md', scheme: 'file', fsPath: '/docs/b.md' };
    const store: HighlightStore = new HighlightStore({ dir, platform: 'linux', coalesceMs: 5, onFilesChanged: changed, onMigrate: (from, to) => history.migrate(from, to) });
    const history: HistoryStore = new HistoryStore({ dir, keyOf: (r) => store.keyOf(r), coalesceMs: 5, onFilesChanged: changed });
    const highlight = makeHighlight('moves with the file');
    await store.update(ref, (r) => r.highlights.push(highlight));
    await history.change(ref, { kind: 'push', step: { op: { kind: 'create', highlight }, label: 'Highlight' } });
    await store.flush();
    await history.flush();

    expect(await store.migrate(ref, moved)).toBe(true);
    await store.flush();
    await history.flush();
    await backup.flush();
    const key = store.keyOf(moved);
    expect(list(dir).every((name) => name.startsWith(key))).toBe(true);
    expect(list(dir)).toContain(`${key}.history.json`);
    expect(list(join(backupDir, ANNOTATIONS_FOLDER))).toEqual(list(dir));
    expect((await history.get(moved)).done).toHaveLength(1);
  });
});
