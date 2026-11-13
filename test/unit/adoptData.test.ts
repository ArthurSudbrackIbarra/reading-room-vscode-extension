// The data of the extension's earlier ids is copied into the new storage folder once.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFolderFromFirst, copyFolderOnce } from '../../src/store/atomicWrite';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reading-room-adopt-'));
  mkdirSync(join(root, 'old', 'highlights', 'nested'), { recursive: true });
  writeFileSync(join(root, 'old', 'highlights', 'a.json'), '{"a":1}');
  writeFileSync(join(root, 'old', 'highlights', 'nested', 'b.gz'), Buffer.from([1, 2, 3]));
  mkdirSync(join(root, 'new'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('copyFolderOnce', () => {
  it('copies the whole folder and leaves the source as it was', () => {
    expect(copyFolderOnce(join(root, 'old', 'highlights'), join(root, 'new', 'highlights'))).toBe(true);
    expect(readFileSync(join(root, 'new', 'highlights', 'a.json'), 'utf8')).toBe('{"a":1}');
    expect([...readFileSync(join(root, 'new', 'highlights', 'nested', 'b.gz'))]).toEqual([1, 2, 3]);
    expect(readFileSync(join(root, 'old', 'highlights', 'a.json'), 'utf8')).toBe('{"a":1}');
    // Nothing temporary is left behind.
    expect(readdirSync(join(root, 'new'))).toEqual(['highlights']);
  });

  it('never replaces a folder that is already there', () => {
    mkdirSync(join(root, 'new', 'highlights'));
    writeFileSync(join(root, 'new', 'highlights', 'mine.json'), 'kept');
    expect(copyFolderOnce(join(root, 'old', 'highlights'), join(root, 'new', 'highlights'))).toBe(false);
    expect(readdirSync(join(root, 'new', 'highlights'))).toEqual(['mine.json']);
  });

  it('does nothing when there is nothing to copy', () => {
    expect(copyFolderOnce(join(root, 'old', 'sounds'), join(root, 'new', 'sounds'))).toBe(false);
    expect(existsSync(join(root, 'new', 'sounds'))).toBe(false);
  });
});

describe('copyFolderFromFirst', () => {
  beforeEach(() => {
    // An even earlier id, with other data.
    mkdirSync(join(root, 'older', 'highlights'), { recursive: true });
    writeFileSync(join(root, 'older', 'highlights', 'a.json'), '{"a":0}');
    mkdirSync(join(root, 'older', 'sounds'), { recursive: true });
    writeFileSync(join(root, 'older', 'sounds', 'sounds.json'), '[]');
  });

  it('takes the folder from the newest earlier id that has it', () => {
    const sources = [join(root, 'old'), join(root, 'older')];
    expect(copyFolderFromFirst(sources, join(root, 'new'), 'highlights')).toBe(join(root, 'old'));
    expect(readFileSync(join(root, 'new', 'highlights', 'a.json'), 'utf8')).toBe('{"a":1}');
  });

  it('goes further back for a folder the newest one does not have', () => {
    const sources = [join(root, 'old'), join(root, 'older')];
    expect(copyFolderFromFirst(sources, join(root, 'new'), 'sounds')).toBe(join(root, 'older'));
    expect(readFileSync(join(root, 'new', 'sounds', 'sounds.json'), 'utf8')).toBe('[]');
  });

  it('leaves what is already there, and copies nothing when no earlier id has the folder', () => {
    mkdirSync(join(root, 'new', 'highlights'));
    writeFileSync(join(root, 'new', 'highlights', 'mine.json'), 'kept');
    expect(copyFolderFromFirst([join(root, 'old'), join(root, 'older')], join(root, 'new'), 'highlights')).toBeUndefined();
    expect(readdirSync(join(root, 'new', 'highlights'))).toEqual(['mine.json']);
    expect(copyFolderFromFirst([join(root, 'missing')], join(root, 'new'), 'sounds')).toBeUndefined();
    expect(existsSync(join(root, 'new', 'sounds'))).toBe(false);
  });
});
