// I9: a downloaded PDF's annotations are computed for the very bytes being downloaded, also when
// a save lands in the middle (D6), with a fake host and viewer. And the hints the editor gives
// about which of two identical blocks is the copy (A14b).
import { describe, expect, it } from 'vitest';
import { CHANGED_DURING_DOWNLOAD, pinnedExport, type PinHost, type ViewerExport } from '../../src/export/pin';
import { duplicateOf, hintFor } from '../../src/preview/copyHints';

/** A host whose document can be saved at any moment, and a viewer that always answers for what it shows. */
class Fake implements PinHost<ViewerExport & { positionsFor: string }> {
  text = 'v1';
  /** What the viewer shows: a render of some text. */
  viewer = { renderId: 1, text: 'v1' };
  renders = 0;
  exports = 0;
  /** Things that happen at given steps (a save while the download is prepared). */
  during: Partial<Record<'source' | 'export', (() => void)[]>> = {};

  private render(): void {
    this.renders++;
    this.viewer = { renderId: this.viewer.renderId + 1, text: this.text };
  }

  async source() {
    const text = this.text;
    if (this.viewer.text !== text) this.render();
    this.during.source?.shift()?.();
    return { bytes: new TextEncoder().encode(`pdf of ${text}`), pin: text };
  }

  shown() {
    return { renderId: this.viewer.renderId, pin: this.viewer.text };
  }

  async requestExport() {
    this.exports++;
    this.during.export?.shift()?.();
    return { renderId: this.viewer.renderId, positionsFor: this.viewer.text };
  }

  async rerender() {
    if (this.viewer.text !== this.text) this.render();
  }

  /** A save: the text changes; the viewer follows a moment later (unless told not to). */
  save(text: string, viewerFollows = true): void {
    this.text = text;
    if (viewerFollows) this.render();
  }
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('pinnedExport', () => {
  it('returns bytes and positions of the same render when nothing changes', async () => {
    const fake = new Fake();
    const { bytes, data } = await pinnedExport(fake);
    expect(decode(bytes)).toBe('pdf of v1');
    expect(data.positionsFor).toBe('v1');
    expect(fake.exports).toBe(1);
  });

  it('brings the viewer up to date first when it shows an older version', async () => {
    const fake = new Fake();
    fake.save('v2', false);
    const { bytes, data } = await pinnedExport(fake);
    expect([decode(bytes), data.positionsFor]).toEqual(['pdf of v2', 'v2']);
  });

  it('D6: a save after the bytes were made: fetches both again, never mixes the two versions', async () => {
    const fake = new Fake();
    fake.during.source = [() => fake.save('v2')];
    const { bytes, data } = await pinnedExport(fake);
    expect([decode(bytes), data.positionsFor]).toEqual(['pdf of v2', 'v2']);
    expect(fake.exports).toBe(2);
  });

  it('a save while the viewer is answering: the same', async () => {
    const fake = new Fake();
    fake.during.export = [() => fake.save('v2')];
    const { bytes, data } = await pinnedExport(fake);
    expect([decode(bytes), data.positionsFor]).toEqual(['pdf of v2', 'v2']);
  });

  it('fails with a clear message when the document keeps changing, instead of a misaligned file', async () => {
    const fake = new Fake();
    fake.during.source = [() => fake.save('v2'), () => fake.save('v3')];
    await expect(pinnedExport(fake)).rejects.toThrow(CHANGED_DURING_DOWNLOAD);
  });

  it('passes on an error from the viewer', async () => {
    const fake = new Fake();
    fake.requestExport = async () => ({ renderId: -1, positionsFor: '', error: 'The viewer was closed.' });
    await expect(pinnedExport(fake)).rejects.toThrow('The viewer was closed.');
  });
});

describe('copy hints', () => {
  const line = 'In the first experiment the quick brown fox jumps.';
  const doc = `Title\n\n${line}\n\nEnd\n`;
  const at = doc.indexOf(line);

  it('Copy Line Down: the copy is inserted before the line; the cursor goes down with it', () => {
    const after = doc.replace(line, `${line}\n${line}`);
    const duplicate = duplicateOf(after, { offset: at, text: `${line}\n`, removed: 0 })!;
    expect(duplicate).toMatchObject({ first: at, second: at + line.length + 1, insertedFirst: true });
    // The cursor is in the lower line, at the column it had: the lower block is the copy.
    expect(hintFor(duplicate, at + line.length + 1 + 12)).toEqual({ text: line, side: 'after' });
  });

  it('Copy Line Up: the copy is inserted after the line; the cursor stays in the upper line', () => {
    const after = doc.replace(line, `${line}\n${line}`);
    const duplicate = duplicateOf(after, { offset: at + line.length, text: `\n${line}`, removed: 0 })!;
    expect(duplicate).toMatchObject({ first: at, second: at + line.length + 1, insertedFirst: false });
    expect(hintFor(duplicate, at + 12)).toEqual({ text: line, side: 'before' });
  });

  it('a paste above or below: the pasted block is the copy (the cursor stands at its end)', () => {
    const above = doc.replace(line, `${line}\n\n${line}`);
    const pastedAbove = duplicateOf(above, { offset: at, text: `${line}\n\n`, removed: 0 })!;
    expect(hintFor(pastedAbove, at + line.length + 2)).toMatchObject({ side: 'before' });
    const pastedBelow = duplicateOf(above, { offset: at + line.length, text: `\n\n${line}`, removed: 0 })!;
    expect(hintFor(pastedBelow, at + 2 * line.length + 2)).toMatchObject({ side: 'after' });
    // Without a cursor (the document is not in a visible editor): the inserted block is the copy.
    expect(hintFor(pastedAbove)).toMatchObject({ side: 'before' });
    expect(hintFor(pastedBelow)).toMatchObject({ side: 'after' });
  });

  it('ignores changes that are not a copy next to its original', () => {
    expect(duplicateOf(`${doc}More text here.`, { offset: doc.length, text: 'More text here.', removed: 0 })).toBeUndefined();
    expect(duplicateOf(doc.replace('Title', 'Titles'), { offset: 5, text: 's', removed: 0 })).toBeUndefined();
    const replaced = doc.replace(line, `${line}\n${line}`);
    expect(duplicateOf(replaced, { offset: at, text: `${line}\n`, removed: 4 })).toBeUndefined();
  });
});
