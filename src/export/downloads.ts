// The Download command's file handling: where the save dialog starts, and the single place a
// PDF is ever written (the path the user picked).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

const DOWNLOADS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

function expandWindowsVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);
}

/** The user's Downloads folder, honouring a relocated folder on Windows and XDG on Linux. */
export async function downloadsFolder(): Promise<string> {
  const home = homedir();
  if (process.platform === 'win32') {
    const out = await run('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '/v',
      DOWNLOADS_GUID,
    ]);
    const match = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(out);
    if (match) {
      const folder = expandWindowsVars(match[1]);
      if (existsSync(folder)) return folder;
    }
  } else if (process.platform === 'linux') {
    const folder = (await run('xdg-user-dir', ['DOWNLOAD'])).trim();
    if (folder && folder !== home && existsSync(folder)) return folder;
  }
  const fallback = join(home, 'Downloads');
  return existsSync(fallback) ? fallback : home;
}

/** Writes the PDF to the location chosen in the save dialog. */
export async function writeDownloadedPdf(target: vscode.Uri, bytes: Uint8Array): Promise<void> {
  await vscode.workspace.fs.writeFile(target, bytes);
}
