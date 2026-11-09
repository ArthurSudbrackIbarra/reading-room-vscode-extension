// Guards the hard constraints: the extension writes files only through store/atomicWrite.ts
// (its global storage folder) and export/ (the path the user picks in the save dialog).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const ALLOWED = new Set(['src/store/atomicWrite.ts', 'src/export/downloads.ts']);
const WRITE_APIS = [
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|mkdir|mkdirSync|mkdtemp|rm|rmSync|rmdir|unlink|unlinkSync|copyFile|copyFileSync|cp|cpSync|truncate|symlink|link)\s*\(/,
  /\bopen\([^)]*['"][wa+]/,
  /workspace\.fs\.(writeFile|delete|rename|copy|createDirectory)\b/,
  /\.applyEdit\(|new WorkspaceEdit\b/,
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|mts)$/.test(name) ? [full] : [];
  });
}

describe('write guard', () => {
  it('only the store and the download code write files', () => {
    const offenders: string[] = [];
    for (const file of [...sources(join(root, 'src')), ...sources(join(root, 'webview'))]) {
      const rel = relative(root, file).split(sep).join('/');
      if (ALLOWED.has(rel)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return;
          const code = line.replace(/\/\/.*$/, '');
          if (WRITE_APIS.some((re) => re.test(code))) offenders.push(`${rel}:${i + 1}: ${trimmed}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('never edits text documents', () => {
    for (const file of sources(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\bTextEdit\b|\beditor\.edit\(|\.applyEdit\(/);
    }
  });
});
