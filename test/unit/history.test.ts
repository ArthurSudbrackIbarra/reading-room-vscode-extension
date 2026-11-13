// The undo history is kept on disk with the annotations, so it lasts when the tab or VS Code is closed.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHistoryChange, type HistoryChange, type StoredHistory, type UndoStep } from '../../src/shared/history';
import type { Highlight, ReadingMarker } from '../../src/shared/types';
import { recordKey, type DocumentRef } from '../../src/store/HighlightStore';
import { HistoryStore, historyFileText, sanitizeHistoryChange, sanitizeHistoryFile, sanitizeStep } from '../../src/store/HistoryStore';
import { UndoStack } from '../../webview/undo';
import { makeDrawing, makeHighlight, makeText } from './helpers';

const AT = '2026-11-13T09:00:00.000Z';
/** A highlight with this id that is the same each time it is made. */
const hl = (id: string, extra: Partial<Highlight> = {}): Highlight => ({ ...makeHighlight(`text of ${id}`), id, createdAt: AT, updatedAt: AT, ...extra });
const marker: ReadingMarker = { pageIndex: 3, y: 0.4, createdAt: '2026-11-13T10:00:00.000Z' };
const step = (id: string, label = 'Highlight'): UndoStep => ({ op: { kind: 'create', highlight: hl(id) }, label });
const ids = (steps: UndoStep[]) => steps.map((s) => (s.op.kind === 'create' ? s.op.highlight.id : s.op.kind));

describe('the stored copy follows the viewer', () => {
  it('ends with the same history as the stack that reported the changes', () => {
    const stored: StoredHistory = { done: [], undone: [] };
    const stack = new UndoStack(500, (change) => change && applyHistoryChange(stored, structuredClone(change)));
    stack.record({ kind: 'create', highlight: hl('a') }, 'Highlight');
    stack.record({ kind: 'create', highlight: hl('b') }, 'Highlight');
    stack.record({ kind: 'create', highlight: hl('c') }, 'Highlight');
    stack.undo();
    stack.undo();
    stack.redo();
    expect(ids(stored.done)).toEqual(['a', 'b']);
    expect(ids(stored.undone)).toEqual(['c']);
    stack.record({ kind: 'create', highlight: hl('d') }, 'Highlight');
    expect(ids(stored.done)).toEqual(['a', 'b', 'd']);
    expect(stored.undone).toEqual([]);
    stack.clear();
    expect(stored).toEqual({ done: [], undone: [] });
  });

  it('keeps no more steps than its limit, and ignores an undo with nothing left', () => {
    const stored: StoredHistory = { done: [], undone: [] };
    for (const id of ['a', 'b', 'c']) applyHistoryChange(stored, { kind: 'push', step: step(id) }, 2);
    expect(ids(stored.done)).toEqual(['b', 'c']);
    for (let i = 0; i < 5; i++) applyHistoryChange(stored, { kind: 'undo' }, 2);
    expect(stored.done).toEqual([]);
    expect(ids(stored.undone)).toEqual(['c', 'b']);
    for (let i = 0; i < 5; i++) applyHistoryChange(stored, { kind: 'redo' }, 2);
    expect(ids(stored.done)).toEqual(['b', 'c']);
  });

  it('goes on where a stored history stopped', () => {
    const reported: HistoryChange[] = [];
    const stack = new UndoStack(500, (change) => change && reported.push(change));
    stack.load({ done: [step('a'), step('b', 'Change color')], undone: [step('c')] });
    // Loading is not a change to store.
    expect(reported).toEqual([]);
    expect(stack.nextUndo).toBe('Change color');
    expect(stack.canRedo).toBe(true);
    expect(stack.undo()?.op).toEqual({ kind: 'delete', highlight: hl('b') });
    expect(stack.redo()?.op).toEqual({ kind: 'create', highlight: hl('b') });
    expect(stack.redo()?.op).toEqual({ kind: 'create', highlight: hl('c') });
    expect(reported.map((c) => c.kind)).toEqual(['undo', 'redo', 'redo']);
    stack.load(undefined);
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
  });

  it('reports a clear only when there was something to clear', () => {
    const reported: (HistoryChange | undefined)[] = [];
    const stack = new UndoStack(500, (change) => reported.push(change));
    stack.clear();
    expect(reported).toEqual([undefined]);
  });
});

describe('steps that are stored are checked', () => {
  it('keeps every kind of step as it was made', () => {
    const drawing = makeDrawing();
    const text = makeText();
    const steps: UndoStep[] = [
      step('a'),
      { op: { kind: 'delete', highlight: hl('b', { note: 'why' }) }, label: 'Delete highlight' },
      { op: { kind: 'update', id: 'a', before: { color: 'yellow', note: '' }, after: { color: 'pink', note: 'so' } }, label: 'Change color' },
      { op: { kind: 'replace', before: hl('a'), after: hl('a', { color: 'green' }) }, label: 'Attach highlight' },
      { op: { kind: 'marker', before: null, after: marker }, label: 'Mark reading position' },
      { op: { kind: 'createDrawing', drawing }, label: 'Draw a line' },
      { op: { kind: 'updateDrawing', before: text, after: { ...text, text: 'Changed' } }, label: 'Edit text' },
      {
        op: {
          kind: 'batch',
          ops: [
            { kind: 'deleteDrawing', drawing },
            { kind: 'delete', highlight: hl('a') },
          ],
        },
        label: 'Delete 2 annotations',
      },
    ];
    for (const s of steps) expect(sanitizeStep(structuredClone(s))).toEqual(s);
  });

  it('does not change what it is given', () => {
    const original = step('a');
    const before = structuredClone(original);
    sanitizeStep(original);
    expect(original).toEqual(before);
  });

  it('refuses what is not a step', () => {
    expect(sanitizeStep(null)).toBeUndefined();
    expect(sanitizeStep({ label: 'x' })).toBeUndefined();
    expect(sanitizeStep({ label: 'x', op: { kind: 'explode' } })).toBeUndefined();
    expect(sanitizeStep({ label: 'x', op: { kind: 'create', highlight: { id: 'a' } } })).toBeUndefined();
    expect(sanitizeStep({ label: 7, op: step('a').op })).toBeUndefined();
    expect(sanitizeStep({ label: 'x', op: { kind: 'update', id: 'a', before: { color: 'no-such-color' }, after: {} } })).toBeUndefined();
    expect(sanitizeStep({ label: 'x', op: { kind: 'replace', before: hl('a'), after: hl('b') } })).toBeUndefined();
    // One bad part makes a step of several parts unusable: it is reverted as a whole or not at all.
    expect(sanitizeStep({ label: 'x', op: { kind: 'batch', ops: [step('a').op, { kind: 'delete' }] } })).toBeUndefined();
  });

  it('refuses steps nested too deep', () => {
    let op: unknown = step('a').op;
    for (let i = 0; i < 6; i++) op = { kind: 'batch', ops: [op] };
    expect(sanitizeStep({ label: 'x', op })).toBeUndefined();
  });

  it('cuts a label that is too long and names a step without one', () => {
    expect(sanitizeStep({ ...step('a'), label: 'x'.repeat(500) })?.label).toHaveLength(120);
    expect(sanitizeStep({ ...step('a'), label: '   ' })?.label).toBe('Change');
  });

  it('reads the changes the viewer reports', () => {
    expect(sanitizeHistoryChange({ kind: 'undo' })).toEqual({ kind: 'undo' });
    expect(sanitizeHistoryChange({ kind: 'redo', extra: 1 })).toEqual({ kind: 'redo' });
    expect(sanitizeHistoryChange({ kind: 'clear' })).toEqual({ kind: 'clear' });
    expect(sanitizeHistoryChange({ kind: 'push', step: step('a') })).toEqual({ kind: 'push', step: step('a') });
    expect(sanitizeHistoryChange({ kind: 'push', step: { label: 'x' } })).toBeUndefined();
    expect(sanitizeHistoryChange({ kind: 'other' })).toBeUndefined();
    expect(sanitizeHistoryChange('undo')).toBeUndefined();
  });

  it('stops at a broken step: what is older than it cannot be reached', () => {
    const read = sanitizeHistoryFile({ done: [step('a'), { label: 'broken' }, step('c'), step('d')], undone: [step('x'), 7, step('z')] });
    expect(ids(read.done)).toEqual(['c', 'd']);
    expect(ids(read.undone)).toEqual(['z']);
    expect(sanitizeHistoryFile('nonsense')).toEqual({ done: [], undone: [] });
    expect(sanitizeHistoryFile({ done: 'x' })).toEqual({ done: [], undone: [] });
  });
});

describe('the history file', () => {
  const ref: DocumentRef = { uri: 'file:///docs/a.md', scheme: 'file', fsPath: '/docs/a.md' };

  it('is not written for an empty history', () => {
    expect(historyFileText(ref, { done: [], undone: [] })).toBeUndefined();
  });

  it('reads back as it was written', () => {
    const history: StoredHistory = { done: [step('a'), step('b')], undone: [step('c')] };
    const text = historyFileText(ref, history) ?? '';
    const json = JSON.parse(text) as { schemaVersion: number; uri: string };
    expect(json.schemaVersion).toBe(1);
    expect(json.uri).toBe(ref.uri);
    expect(sanitizeHistoryFile(json)).toEqual(history);
  });

  it('drops the oldest steps to stay under its size limit', () => {
    const history: StoredHistory = { done: ['a', 'b', 'c', 'd'].map((id) => step(id)), undone: [step('z')] };
    const one = Buffer.byteLength(JSON.stringify(step('a')), 'utf8') + 1;
    const read = sanitizeHistoryFile(JSON.parse(historyFileText(ref, history, one * 3) ?? '{}'));
    expect(ids(read.done)).toEqual(['c', 'd']);
    expect(ids(read.undone)).toEqual(['z']);
    // What is in memory is not cut: the viewer keeps undoing while it is open.
    expect(history.done).toHaveLength(4);
    expect(historyFileText(ref, history, 10)).toBeUndefined();
  });
});

describe('HistoryStore', () => {
  let dir: string;
  const ref: DocumentRef = { uri: 'file:///docs/a.md', scheme: 'file', fsPath: '/docs/a.md' };
  const other: DocumentRef = { uri: 'file:///docs/b.md', scheme: 'file', fsPath: '/docs/b.md' };
  const keyOf = (r: DocumentRef) => recordKey(r, 'linux');
  const make = (changed: string[] = []) => new HistoryStore({ dir, keyOf, coalesceMs: 5, onFilesChanged: (key) => changed.push(key) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reading-room-history-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is empty for a document without history', async () => {
    expect(await make().get(ref)).toEqual({ done: [], undone: [] });
  });

  it('is still there after the extension started again', async () => {
    const changed: string[] = [];
    const first = make(changed);
    await first.change(ref, { kind: 'push', step: step('a') });
    await first.change(ref, { kind: 'push', step: step('b', 'Delete highlight') });
    await first.change(ref, { kind: 'undo' });
    await first.flush();
    expect(changed).toEqual([keyOf(ref)]);
    expect(existsSync(first.pathOf(keyOf(ref)))).toBe(true);

    const second = make();
    const history = await second.get(ref);
    expect(ids(history.done)).toEqual(['a']);
    expect(history.undone.map((s) => s.label)).toEqual(['Delete highlight']);
    expect(await second.get(other)).toEqual({ done: [], undone: [] });
  });

  it('gives a copy: changing it does not change what is stored', async () => {
    const store = make();
    await store.change(ref, { kind: 'push', step: step('a') });
    (await store.get(ref)).done.length = 0;
    expect((await store.get(ref)).done).toHaveLength(1);
  });

  it('removes the file when nothing is left', async () => {
    const store = make();
    await store.change(ref, { kind: 'push', step: step('a') });
    await store.flush();
    await store.change(ref, { kind: 'clear' });
    await store.flush();
    expect(existsSync(store.pathOf(keyOf(ref)))).toBe(false);
  });

  it('starts again when the viewer reports a step that is not valid', async () => {
    const store = make();
    await store.change(ref, { kind: 'push', step: step('a') });
    await store.change(ref, sanitizeHistoryChange({ kind: 'push', step: { label: 'x', op: { kind: 'nonsense' } } }));
    expect(await store.get(ref)).toEqual({ done: [], undone: [] });
  });

  it('starts empty from a file that is not valid, and writes over it', async () => {
    const store = make();
    writeFileSync(store.pathOf(keyOf(ref)), '{ not json');
    expect(await store.get(ref)).toEqual({ done: [], undone: [] });
    await store.change(ref, { kind: 'push', step: step('a') });
    await store.flush();
    expect(ids(sanitizeHistoryFile(JSON.parse(readFileSync(store.pathOf(keyOf(ref)), 'utf8'))).done)).toEqual(['a']);
  });

  it('leaves a file of a newer version as it is', async () => {
    const store = make();
    const file = store.pathOf(keyOf(ref));
    const newer = JSON.stringify({ schemaVersion: 99, done: [{ something: 'new' }], undone: [] });
    writeFileSync(file, newer);
    expect(await store.get(ref)).toEqual({ done: [], undone: [] });
    await store.change(ref, { kind: 'push', step: step('a') });
    await store.flush();
    expect(readFileSync(file, 'utf8')).toBe(newer);
  });

  it('follows a renamed document', async () => {
    const changed: string[] = [];
    const store = make(changed);
    await store.change(ref, { kind: 'push', step: step('a') });
    await store.migrate(ref, other);
    expect(existsSync(store.pathOf(keyOf(ref)))).toBe(false);
    expect(ids((await store.get(other)).done)).toEqual(['a']);
    expect(await store.get(ref)).toEqual({ done: [], undone: [] });
    expect(changed).toContain(keyOf(other));
  });

  it('keeps the history the new path has already', async () => {
    const store = make();
    await store.change(ref, { kind: 'push', step: step('a') });
    await store.change(other, { kind: 'push', step: step('b') });
    await store.migrate(ref, other);
    expect(ids((await store.get(other)).done)).toEqual(['b']);
    expect(existsSync(store.pathOf(keyOf(ref)))).toBe(false);
  });

  it('forgets a document whose viewer closed only when everything is written', async () => {
    const store = make();
    await store.change(ref, { kind: 'push', step: step('a') });
    store.evict(ref);
    await store.flush();
    store.evict(ref);
    expect(ids((await make().get(ref)).done)).toEqual(['a']);
  });
});
