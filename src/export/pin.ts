// Pins a download to one render: the annotations a viewer reports must have been computed for
// the very bytes that are downloaded. A save that lands while the download is being prepared
// would otherwise put one version's positions on another version's pages.
// Pure orchestration (no vscode), so it is unit-testable with a fake host and viewer.

export interface PinnedSource {
  /** The PDF to download. */
  bytes: Uint8Array;
  /** Identifies the text and layout settings the bytes were made from. */
  pin: string;
}

export interface ViewerExport {
  /** The render the viewer computed its positions for. */
  renderId: number;
  error?: string;
}

export interface PinHost<T extends ViewerExport> {
  /** Brings the viewer up to date and returns the bytes to download with their pin. */
  source(): Promise<PinnedSource>;
  /** What the viewer shows now: its render and the pin of what that render was made from. */
  shown(): { renderId: number; pin: string } | undefined;
  /** Asks the viewer for its annotations (it answers for the render it shows). */
  requestExport(): Promise<T>;
  /** Renders the current text again. */
  rerender(): Promise<void>;
}

export const CHANGED_DURING_DOWNLOAD = 'The document kept changing while the download was being prepared. Save it and try again.';

/**
 * Returns the bytes and the viewer's annotations for them. When the viewer answered for another
 * render than the bytes were made from, everything is fetched once more; a second mismatch fails
 * with a clear message instead of producing a misaligned file.
 */
export async function pinnedExport<T extends ViewerExport>(host: PinHost<T>): Promise<{ bytes: Uint8Array; data: T }> {
  for (let attempt = 0; ; attempt++) {
    const source = await host.source();
    const data = await host.requestExport();
    if (data.error) throw new Error(data.error);
    const shown = host.shown();
    if (shown && data.renderId === shown.renderId && shown.pin === source.pin) return { bytes: source.bytes, data };
    if (attempt >= 1) throw new Error(CHANGED_DURING_DOWNLOAD);
    await host.rerender();
  }
}
