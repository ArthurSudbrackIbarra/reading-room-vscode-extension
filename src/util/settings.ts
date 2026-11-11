import * as vscode from 'vscode';
import type { PageSize } from '../shared/types';

export const SECTION = 'markdownPdfViewer';

export interface Settings {
  defaultOpenMode: 'side' | 'full';
  pageSize: PageSize;
  pageNumbers: boolean;
  renderOnSave: boolean;
  allowRemoteImages: boolean;
  chromiumPath: string;
  chromiumDownload: 'ask' | 'never';
  /** Days a converted PDF stays in the disk cache after its last use; 0 turns the cache off. */
  cacheDays: number;
  /** Keep the text of the versions annotations were last found in, to follow them through edits. */
  textSnapshots: boolean;
}

/**
 * Reads the settings without a resource scope. They are all `application`/`machine` scoped,
 * so only user settings apply and workspace settings can never change the behaviour.
 */
export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration(SECTION);
  const cacheDays = Number(c.get<number>('cacheDays') ?? 7);
  return {
    defaultOpenMode: c.get<string>('defaultOpenMode') === 'full' ? 'full' : 'side',
    pageSize: c.get<string>('pageSize') === 'Letter' ? 'Letter' : 'A4',
    pageNumbers: c.get<boolean>('pageNumbers') !== false,
    renderOnSave: c.get<boolean>('renderOnSave') !== false,
    allowRemoteImages: c.get<boolean>('allowRemoteImages') !== false,
    chromiumPath: (c.get<string>('chromiumPath') ?? '').trim(),
    chromiumDownload: c.get<string>('chromiumDownload') === 'never' ? 'never' : 'ask',
    cacheDays: Number.isFinite(cacheDays) ? Math.min(365, Math.max(0, Math.floor(cacheDays))) : 7,
    textSnapshots: c.get<boolean>('textSnapshots') !== false,
  };
}

/** Settings that change the generated PDF; a change re-renders open previews. */
export const RENDER_SETTINGS = ['pageSize', 'pageNumbers', 'allowRemoteImages', 'chromiumPath'].map((k) => `${SECTION}.${k}`);
