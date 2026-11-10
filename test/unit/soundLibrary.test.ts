import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SOUND_FILE_BYTES, SoundLibrary, cleanSoundName, soundNameFromFile, type SoundFile } from '../../src/store/SoundLibrary';

let base: string;
let dir: string;
let originals: string;
const warnings: string[] = [];
const log = { warn: (message: string) => warnings.push(message) };

/** A file of the reader's to add (its content does not matter here). */
function original(name: string, content = `audio of ${name}`): SoundFile {
  const path = join(originals, name);
  writeFileSync(path, content);
  return { name, size: Buffer.byteLength(content), path };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mpv-sounds-'));
  dir = join(base, 'globalStorage', 'sounds');
  originals = join(base, 'Music');
  mkdirSync(originals);
  warnings.length = 0;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('sound names', () => {
  it('come from the file name, cleaned up', () => {
    expect(soundNameFromFile('Rain_on_a_tent.mp3')).toBe('Rain on a tent');
    expect(soundNameFromFile('  calm   rain .ogg')).toBe('calm rain');
    expect(soundNameFromFile('.ogg')).toBe('.ogg');
    expect(soundNameFromFile('___.wav')).toBe('Sound');
    expect(cleanSoundName('x'.repeat(200))).toHaveLength(80);
    expect(cleanSoundName('   ')).toBeUndefined();
    expect(cleanSoundName(5)).toBeUndefined();
  });
});

describe('SoundLibrary', () => {
  it('copies added files into its folder and lists them', async () => {
    const library = new SoundLibrary(dir, log);
    const result = await library.add([original('Rain on a tent.mp3'), original('fire.FLAC')]);
    expect(result.skipped).toEqual([]);
    expect(result.added.map((r) => r.name)).toEqual(['Rain on a tent', 'fire']);
    for (const record of result.added) {
      expect(record.id).toMatch(/^custom-[0-9a-f]{12}$/);
      expect(record.file).toBe(`${record.id}.${record.source.name.split('.').pop()?.toLowerCase()}`);
      expect(readFileSync(library.pathOf(record), 'utf8')).toBe(`audio of ${record.source.name}`);
    }
    // The originals stay where they were.
    expect(readdirSync(originals).sort()).toEqual(['Rain on a tent.mp3', 'fire.FLAC']);
    // Another instance (another VS Code window) reads the same list.
    const other = new SoundLibrary(dir, log);
    expect(await other.reload()).toBe(true);
    expect(other.sounds.map((r) => r.name)).toEqual(['Rain on a tent', 'fire']);
    expect(await other.reload()).toBe(false);
  });

  it('skips files of the wrong kind, empty, too large or already added', async () => {
    const library = new SoundLibrary(dir, log);
    await library.add([original('rain.mp3')]);
    const result = await library.add([
      original('song.m4a'),
      original('notes.txt'),
      { name: 'empty.wav', size: 0, path: join(originals, 'empty.wav') },
      { name: 'huge.wav', size: MAX_SOUND_FILE_BYTES + 1, path: join(originals, 'huge.wav') },
      original('rain.mp3'),
      { name: 'gone.ogg', size: 10, path: join(originals, 'gone.ogg') },
    ]);
    expect(result.added).toEqual([]);
    expect(result.skipped.map((s) => [s.file, s.reason.split(' ').slice(0, 3).join(' ')])).toEqual([
      ['song.m4a', 'is not an'],
      ['notes.txt', 'is not an'],
      ['empty.wav', 'is empty'],
      ['huge.wav', 'is 150 MB;'],
      ['rain.mp3', 'is already one'],
      ['gone.ogg', 'could not be'],
    ]);
    expect(library.sounds).toHaveLength(1);
    // Nothing half-copied is left behind.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('gives two sounds with the same name distinct names', async () => {
    const library = new SoundLibrary(dir, log);
    const { added } = await library.add([original('rain.mp3', 'a'), original('rain.ogg', 'bb'), original('Rain.wav', 'ccc')]);
    expect(added.map((r) => r.name)).toEqual(['rain', 'rain (2)', 'Rain (3)']);
  });

  it('adds files read through VS Code (remote workspaces)', async () => {
    const library = new SoundLibrary(dir, log);
    const { added } = await library.add([{ name: 'remote.ogg', size: 3, read: async () => new Uint8Array([1, 2, 3]) }]);
    expect([...readFileSync(library.pathOf(added[0]))]).toEqual([1, 2, 3]);
  });

  it('renames, remembers levels, and removes (deleting only its copy)', async () => {
    const library = new SoundLibrary(dir, log);
    const [a, b] = (await library.add([original('a.mp3'), original('b.mp3')])).added;
    expect(await library.renameSound(a.id, '  Night   rain ')).toBe(true);
    expect(await library.renameSound(a.id, 'Night rain')).toBe(false);
    expect(await library.renameSound(a.id, '   ')).toBe(false);
    expect(await library.renameSound('custom-nope0000', 'x')).toBe(false);
    expect(await library.setGain(b.id, 12.3456)).toBe(true);
    expect(await library.setGain(b.id, 12.35)).toBe(false);
    expect(await library.setGain(b.id, 99)).toBe(true);
    const other = new SoundLibrary(dir, log);
    await other.reload();
    expect(other.sounds.map((r) => [r.name, r.gainDb])).toEqual([
      ['Night rain', undefined],
      ['b', 24],
    ]);
    const copy = library.pathOf(a);
    expect((await library.removeSound(a.id))?.name).toBe('Night rain');
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(join(originals, 'a.mp3'))).toBe(true);
    expect(await library.removeSound(a.id)).toBeUndefined();
    expect(library.sounds.map((r) => r.name)).toEqual(['b']);
  });

  it("merges another window's changes instead of overwriting them", async () => {
    const one = new SoundLibrary(dir, log);
    const two = new SoundLibrary(dir, log);
    await one.add([original('one.mp3')]);
    await two.add([original('two.mp3')]);
    await one.add([original('three.mp3')]);
    await two.reload();
    expect(two.sounds.map((r) => r.name)).toEqual(['one', 'two', 'three']);
  });

  it('runs changes one after another', async () => {
    const library = new SoundLibrary(dir, log);
    const results = await Promise.all([library.add([original('x.mp3')]), library.add([original('y.mp3')]), library.add([original('z.mp3')])]);
    expect(results.map((r) => r.added.length)).toEqual([1, 1, 1]);
    const other = new SoundLibrary(dir, log);
    await other.reload();
    expect(other.sounds).toHaveLength(3);
  });

  it('leaves out records that are not valid, or whose file is gone', async () => {
    const library = new SoundLibrary(dir, log);
    const { added } = await library.add([original('kept.mp3'), original('lost.mp3')]);
    rmSync(library.pathOf(added[1]));
    const index = JSON.parse(readFileSync(join(dir, 'sounds.json'), 'utf8'));
    index.sounds.push(
      { id: 'custom-evil0000', name: 'evil', file: '../../escape.mp3' },
      { id: 'not-custom', name: 'x', file: 'x.mp3' },
      { id: 'custom-opus0000', name: 'opus', file: 'custom-opus0000.opus' },
      { id: added[0].id, name: 'duplicate', file: added[0].file },
      { id: 'custom-gain0000', name: 'bad gain', file: added[0].file, gainDb: 'loud' },
    );
    writeFileSync(join(dir, 'sounds.json'), JSON.stringify(index));
    const other = new SoundLibrary(dir, log);
    await other.reload();
    expect(other.sounds.map((r) => [r.id, r.name, r.gainDb])).toEqual([
      [added[0].id, 'kept', undefined],
      ['custom-gain0000', 'bad gain', undefined],
    ]);
    expect(warnings.some((w) => w.includes('lost'))).toBe(true);
  });

  it('sets an unreadable list aside and starts over', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sounds.json'), '{ not json');
    const library = new SoundLibrary(dir, log);
    await library.reload();
    expect(library.sounds).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith('sounds.json.corrupt-'))).toBe(true);
    expect(warnings[0]).toMatch(/unreadable/);
    const { added } = await library.add([original('fresh.ogg')]);
    expect(added).toHaveLength(1);
  });

  it('is empty when nothing was added yet', async () => {
    const library = new SoundLibrary(dir, log);
    expect(await library.reload()).toBe(false);
    expect(library.sounds).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });
});
