// Text boxes in the viewer: how their text is styled, measured, shown and edited. The page shows
// a text box as HTML inside the page's SVG (a foreignObject in page units, so it zooms with the
// page), the editor is an editable element with the very same styles laid out at the same size
// and scaled to the zoom, and a hidden twin measures boxes: all three wrap lines identically.
// Bold, italic and underlined parts are spans inside that text.
import { MAX_TEXT_LENGTH, TEXT_LINE_HEIGHT, TEXT_PAD_Y, cleanText, type TextDrawing, type TextLayout } from '../src/shared/drawings';
import { PLAIN, rangeStyle, replaceRange, styleAt, styleRange, textRuns, type CharStyle, type CharStyleName, type TextSpan } from '../src/shared/richText';
import { setInk } from './drawings';

export interface BoxSize {
  width: number;
  height: number;
}

type Styled = Pick<TextDrawing, 'size' | 'align' | 'color' | 'boxWidth'>;
type StyledText = Styled & Pick<TextDrawing, 'text' | 'spans'>;

/** Gives an element (shown text, measurer or editor) the style of a text box. Sizes are in points. */
export function styleTextElement(el: HTMLElement, text: Styled): void {
  el.classList.add('mpv-text-body');
  setInk(el, text.color);
  el.style.setProperty('font-size', `${text.size}px`);
  el.style.setProperty('text-align', text.align);
  if (text.boxWidth === undefined) {
    el.style.setProperty('width', 'max-content');
    el.style.setProperty('white-space', 'pre');
  } else {
    el.style.setProperty('width', `${text.boxWidth}px`);
    el.style.setProperty('white-space', 'pre-wrap');
  }
}

/** The classes of a stretch of text in one style ('' for plain text). */
function runClass(style: CharStyle): string {
  return [style.bold && 'mpv-t-b', style.italic && 'mpv-t-i', style.underline && 'mpv-t-u'].filter(Boolean).join(' ');
}

/** A stretch of text in one style: a text node, inside a span if it is bold, italic or underlined. */
function runNode(text: string, className: string): Node {
  const node = document.createTextNode(text);
  if (!className) return node;
  const span = document.createElement('span');
  span.className = className;
  span.append(node);
  return span;
}

/** Fills an element with a text, its styled parts in spans. */
export function fillText(el: HTMLElement, text: string, spans: readonly TextSpan[] | undefined): void {
  el.replaceChildren(...textRuns(text, spans).map((run) => runNode(run.text, runClass(run))));
}

/** The text nodes of an element in order, and where each starts in the text. */
function textNodes(el: HTMLElement): { node: Text; start: number }[] {
  const nodes: { node: Text; start: number }[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let start = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start });
    start += (node as Text).length;
  }
  return nodes;
}

/** Visits each character of the text shown in `el` with the boxes it is drawn in. */
function eachCharacter(el: HTMLElement, text: string, visit: (ch: string, index: number, end: number, rects: DOMRectList | undefined) => void): void {
  const nodes = textNodes(el);
  const range = document.createRange();
  let k = 0;
  let index = 0;
  for (const ch of text) {
    const end = index + ch.length;
    while (k < nodes.length - 1 && index >= nodes[k].start + nodes[k].node.length) k++;
    const at = nodes[k];
    let rects: DOMRectList | undefined;
    if (at && ch !== '\n' && end - at.start <= at.node.length) {
      range.setStart(at.node, index - at.start);
      range.setEnd(at.node, end - at.start);
      rects = range.getClientRects();
    }
    visit(ch, index, end, rects);
    index = end;
  }
}

/** The height of a box of `lines` lines. */
export function boxHeight(size: number, lines: number): number {
  return Math.max(1, lines) * size * TEXT_LINE_HEIGHT + 2 * TEXT_PAD_Y;
}

/** Measures text boxes with a hidden element styled like them (in points: one CSS pixel each). */
export class TextMeasurer {
  private readonly el: HTMLDivElement;
  private readonly cache = new WeakMap<TextDrawing, BoxSize>();

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'mpv-text-measure';
    this.el.setAttribute('aria-hidden', 'true');
    document.body.append(this.el);
  }

  /** The size of a stored text box (cached per version of it). */
  size(text: TextDrawing): BoxSize {
    let size = this.cache.get(text);
    if (!size) {
      size = this.measure(text);
      this.cache.set(text, size);
    }
    return size;
  }

  /** The size a box would have with this text and style. */
  measure(text: StyledText): BoxSize {
    const el = this.prepare(text);
    const lines = text.text.length === 0 ? 1 : this.lines(el, text.text).length;
    const width = el.getBoundingClientRect().width;
    return { width: Math.max(width, 1), height: boxHeight(text.size, lines) };
  }

  /** The lines of a text box as it shows them, for the download. */
  layout(text: TextDrawing): TextLayout {
    const el = this.prepare(text);
    const lines = this.lines(el, text.text);
    const width = el.getBoundingClientRect().width;
    return { id: text.id, lines, width: Math.max(width, 1), height: boxHeight(text.size, lines.length) };
  }

  /**
   * The character offset nearest to a point of a box (in points from its top left corner): where
   * a click inside a box puts the caret.
   */
  offsetAt(text: StyledText, x: number, y: number): number {
    const el = this.prepare(text);
    const origin = el.getBoundingClientRect();
    let best = text.text.length;
    let bestScore = Infinity;
    eachCharacter(el, text.text, (_ch, index, end, rects) => {
      const r = rects?.[0];
      if (!r) return;
      const top = r.top - origin.top;
      const bottom = r.bottom - origin.top;
      const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
      const mid = r.left - origin.left + r.width / 2;
      const score = dy * 1000 + Math.abs(x - mid);
      if (score < bestScore) {
        bestScore = score;
        best = x < mid ? index : end;
      }
    });
    return best;
  }

  private prepare(text: StyledText): HTMLDivElement {
    const el = this.el;
    el.className = 'mpv-text-measure';
    styleTextElement(el, text);
    fillText(el, text.text, text.spans);
    return el;
  }

  /** Splits the shown text into its lines (soft wraps found from where each character is drawn). */
  private lines(el: HTMLDivElement, text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    let lastTop: number | undefined;
    eachCharacter(el, text, (ch, index, end, rects) => {
      if (ch === '\n') {
        lines.push(text.slice(start, index));
        start = end;
        lastTop = undefined;
        return;
      }
      // A space where a line wraps can have no box or one at the end of the line before.
      const rect = rects?.[rects.length - 1];
      if (!rect || rect.width <= 0) return;
      if (lastTop !== undefined && rect.top > lastTop + 1 && ch !== ' ') {
        lines.push(text.slice(start, index));
        start = index;
      }
      lastTop = rect.top;
    });
    lines.push(text.slice(start));
    return lines;
  }
}

/** The HTML that shows a text box on the page (inside its foreignObject). */
export function textContentElement(text: TextDrawing): HTMLDivElement {
  const div = document.createElement('div');
  styleTextElement(div, text);
  fillText(div, text.text, text.spans);
  return div;
}

export interface EditorEvents {
  /** The text or the style of a part of it changed. */
  input(): void;
  /** The caret or the selection moved, or the style of what is typed next changed. */
  selection(): void;
  /** Esc, or Ctrl/Cmd+Enter: done editing. */
  finish(): void;
  /** Something to tell the reader. */
  notice(message: string): void;
}

interface Snapshot {
  text: string;
  spans: TextSpan[] | undefined;
  anchor: number;
  focus: number;
}

type EditKind = 'type' | 'delete' | 'other';

/** Changes a text node's characters to `value`, touching only what differs (spelling marks elsewhere stay). */
function setData(node: Text, value: string): void {
  const old = node.data;
  if (old === value) return;
  let prefix = 0;
  while (prefix < old.length && prefix < value.length && old[prefix] === value[prefix]) prefix++;
  let suffix = 0;
  while (suffix < old.length - prefix && suffix < value.length - prefix && old[old.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
  node.replaceData(prefix, old.length - prefix - suffix, value.slice(prefix, value.length - suffix));
}

/**
 * The editor of the text box being typed in: an editable element laid out in points like the
 * shown text, scaled to the zoom with a transform, and placed over the box inside the scrolling
 * container (so it scrolls with the page and survives PDF.js re-creating the page's layers).
 *
 * The editor owns the text: every change the reader makes (typing, deleting, pasting, cutting)
 * is applied to its own copy of the text and of the styled parts, and the element is redrawn
 * from that. So the element only ever holds text nodes and bold/italic/underline spans, pasted
 * text is plain, and bold can be put on any part. Undo and redo (while typing) are its own too.
 */
export class TextEditor {
  readonly element: HTMLDivElement;
  private text = '';
  private styled: TextSpan[] | undefined;
  /** The style of what is typed next. */
  private typing: CharStyle = { ...PLAIN };
  /** The selection, as offsets in the text (equal: a caret). */
  private anchor = 0;
  private focusAt = 0;
  private composing = false;
  private readonly undone: Snapshot[] = [];
  private readonly history: Snapshot[] = [];
  private lastEdit?: { kind: EditKind; time: number; at: number };

  constructor(
    private readonly container: HTMLElement,
    private readonly events: EditorEvents,
  ) {
    const el = document.createElement('div');
    el.className = 'mpv-text-editor';
    el.contentEditable = 'true';
    el.spellcheck = true;
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-multiline', 'true');
    el.setAttribute('aria-label', 'Text box');
    el.hidden = true;
    this.element = el;
    el.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    el.addEventListener('input', () => this.syncFromElement());
    el.addEventListener('compositionstart', () => (this.composing = true));
    el.addEventListener('compositionend', () => {
      this.composing = false;
      // The last change of the composition may come right after this event.
      setTimeout(() => {
        if (!this.open || this.composing) return;
        this.syncFromElement();
        this.render();
        this.select(this.anchor, this.focusAt);
      }, 0);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        e.stopPropagation();
        events.finish();
      } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        const [start, end] = this.range();
        this.replace(start, end, '    ', 'type');
      }
    });
    // Text is not dragged around inside the box, nor dropped into it (dropped text could carry markup).
    el.addEventListener('dragstart', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => e.preventDefault());
    document.addEventListener('selectionchange', () => this.onSelectionChange());
    container.append(el);
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  get value(): string {
    return this.text;
  }

  /** The bold, italic and underlined parts of the text. */
  get spans(): TextSpan[] | undefined {
    return this.styled ? this.styled.map((span) => ({ ...span })) : undefined;
  }

  /** Bold, italic and underline at the caret (what is typed next), or of all of the selection. */
  get charStyle(): CharStyle {
    const [start, end] = this.range();
    return start === end ? { ...this.typing } : rangeStyle(this.text, this.styled, start, end);
  }

  /** Whether there is a selection (not just a caret). */
  get hasSelection(): boolean {
    return this.anchor !== this.focusAt;
  }

  /** Opens the editor on a text: the caret at `caret` (or the end), typing in `typing` (or the style there). */
  show(text: StyledText, caret?: number, typing?: CharStyle): void {
    this.text = text.text;
    this.styled = text.spans?.map((span) => ({ ...span }));
    this.history.length = 0;
    this.undone.length = 0;
    this.lastEdit = undefined;
    this.composing = false;
    this.restyle(text);
    this.element.replaceChildren();
    this.render();
    this.element.hidden = false;
    this.element.focus({ preventScroll: true });
    const at = Math.max(0, Math.min(this.text.length, caret ?? this.text.length));
    this.select(at, at);
    this.typing = typing ? { ...typing } : this.styleBefore(at);
  }

  restyle(text: Styled): void {
    this.element.className = 'mpv-text-editor';
    styleTextElement(this.element, text);
  }

  /** Places the editor: its top left corner (container content pixels), its least width in points, the zoom. */
  place(left: number, top: number, minWidth: number, scale: number): void {
    const s = this.element.style;
    s.left = `${left}px`;
    s.top = `${top}px`;
    s.minWidth = `${minWidth}px`;
    s.transform = `scale(${scale})`;
    s.setProperty('--mpv-unscale', String(1 / scale));
  }

  focus(): void {
    if (!this.open) return;
    this.element.focus({ preventScroll: true });
    this.select(this.anchor, this.focusAt);
  }

  hide(): void {
    const hadFocus = document.activeElement === this.element;
    this.element.hidden = true;
    this.element.replaceChildren();
    this.text = '';
    this.styled = undefined;
    this.history.length = 0;
    this.undone.length = 0;
    if (hadFocus) this.container.focus({ preventScroll: true });
  }

  /**
   * Bold, italic or underline: on the selection (off if all of it has it, else on), or, with just
   * a caret, for what is typed next. Returns the new state.
   */
  toggle(name: CharStyleName): boolean {
    const [start, end] = this.range();
    if (start === end) {
      this.typing = { ...this.typing, [name]: !this.typing[name] };
      this.events.selection();
      return this.typing[name];
    }
    const on = !rangeStyle(this.text, this.styled, start, end)[name];
    this.remember('other', start);
    this.styled = styleRange(this.styled, this.text.length, start, end, { [name]: on });
    this.typing = { ...this.typing, [name]: on };
    this.render();
    this.select(this.anchor, this.focusAt);
    this.events.input();
    this.events.selection();
    return on;
  }

  /** Takes back the last change made while typing here. False if there is none. */
  undo(): boolean {
    return this.restore(this.history, this.undone);
  }

  redo(): boolean {
    return this.restore(this.undone, this.history);
  }

  // ---------- The text ----------

  private range(): [number, number] {
    return [Math.min(this.anchor, this.focusAt), Math.max(this.anchor, this.focusAt)];
  }

  /** The style typing continues in at a caret: that of the character before it (on its line), else of the one after. */
  private styleBefore(at: number): CharStyle {
    if (at > 0 && this.text[at - 1] !== '\n') return styleAt(this.styled, at - 1);
    if (at < this.text.length && this.text[at] !== '\n') return styleAt(this.styled, at);
    return { ...this.typing };
  }

  private snapshot(): Snapshot {
    return { text: this.text, spans: this.spans, anchor: this.anchor, focus: this.focusAt };
  }

  /** Keeps the state before a change for undo. Typing on (or deleting on) within a second is one step. */
  private remember(kind: EditKind, start: number, end = start): void {
    const now = performance.now();
    const last = this.lastEdit;
    const joins = last !== undefined && kind !== 'other' && last.kind === kind && now - last.time < 1000 && (last.at === start || last.at === end);
    if (!joins) {
      this.history.push(this.snapshot());
      if (this.history.length > 300) this.history.shift();
    }
    this.undone.length = 0;
    this.lastEdit = { kind, time: now, at: start };
  }

  private restore(from: Snapshot[], to: Snapshot[]): boolean {
    const snapshot = from.pop();
    if (!snapshot) return false;
    to.push(this.snapshot());
    this.text = snapshot.text;
    this.styled = snapshot.spans;
    this.lastEdit = undefined;
    this.render();
    this.select(snapshot.anchor, snapshot.focus);
    this.typing = this.styleBefore(this.focusAt);
    this.events.input();
    this.events.selection();
    return true;
  }

  /** Replaces characters [start, end) by text typed, pasted or composed (in the typing style). */
  private replace(start: number, end: number, raw: string, kind: EditKind): void {
    let insert = cleanText(raw);
    const room = MAX_TEXT_LENGTH - (this.text.length - (end - start));
    if (insert.length > room) {
      insert = insert.slice(0, Math.max(0, room));
      this.events.notice(`A text box holds up to ${MAX_TEXT_LENGTH.toLocaleString()} characters.`);
    }
    if (start === end && insert === '') return;
    this.remember(insert === '' ? 'delete' : kind, start, end);
    this.styled = replaceRange(this.styled, this.text.length, start, end, insert.length, this.typing);
    this.text = this.text.slice(0, start) + insert + this.text.slice(end);
    const caret = start + insert.length;
    if (this.lastEdit) this.lastEdit.at = caret;
    this.render();
    this.select(caret, caret);
    if (insert === '') this.typing = this.styleBefore(caret);
    this.events.input();
  }

  /**
   * The browser changed the element itself (an input method composing a character, or anything
   * not caught before it happened): take its text, in the typing style where it differs.
   */
  private syncFromElement(): void {
    const now = this.element.textContent ?? '';
    const old = this.text;
    if (now === old) return;
    let prefix = 0;
    while (prefix < old.length && prefix < now.length && old[prefix] === now[prefix]) prefix++;
    let suffix = 0;
    while (suffix < old.length - prefix && suffix < now.length - prefix && old[old.length - 1 - suffix] === now[now.length - 1 - suffix]) suffix++;
    this.remember('type', prefix);
    this.styled = replaceRange(this.styled, old.length, prefix, old.length - suffix, now.length - suffix - prefix, this.typing);
    this.text = now;
    const caret = now.length - suffix;
    if (this.lastEdit) this.lastEdit.at = caret;
    const selection = this.readSelection();
    [this.anchor, this.focusAt] = selection ?? [caret, caret];
    if (!this.composing) {
      this.render();
      this.select(this.anchor, this.focusAt);
    }
    this.events.input();
  }

  private onBeforeInput(e: InputEvent): void {
    // An input method composes in the element itself; its text is taken when it changes (see syncFromElement).
    if (e.isComposing || e.inputType === 'insertCompositionText' || e.inputType === 'insertFromComposition' || e.inputType === 'deleteCompositionText') return;
    e.preventDefault();
    const type = e.inputType;
    if (type === 'historyUndo') {
      this.undo();
      return;
    }
    if (type === 'historyRedo') {
      this.redo();
      return;
    }
    if (type === 'formatBold' || type === 'formatItalic' || type === 'formatUnderline') {
      this.toggle(type === 'formatBold' ? 'bold' : type === 'formatItalic' ? 'italic' : 'underline');
      return;
    }
    const range = this.targetRange(e);
    if (!range) return;
    const [start, end] = range;
    if (type.startsWith('delete')) {
      this.replace(start, end, '', 'delete');
    } else if (type === 'insertLineBreak' || type === 'insertParagraph') {
      this.replace(start, end, '\n', 'other');
    } else if (type.startsWith('insert')) {
      const data = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
      this.replace(start, end, data, type === 'insertText' && data.length === 1 && data !== ' ' ? 'type' : 'other');
    }
  }

  /** The characters a change is about to replace: what the browser says, else the selection. */
  private targetRange(e: InputEvent): [number, number] | undefined {
    const target = e.getTargetRanges?.()[0];
    if (target && this.element.contains(target.startContainer) && this.element.contains(target.endContainer)) {
      const a = this.offsetOf(target.startContainer, target.startOffset);
      const b = this.offsetOf(target.endContainer, target.endOffset);
      return [Math.min(a, b), Math.max(a, b)];
    }
    const selection = this.readSelection();
    if (!selection) return undefined;
    const [start, end] = [Math.min(...selection), Math.max(...selection)];
    if (start !== end || !e.inputType.startsWith('delete')) return [start, end];
    // A caret, and the browser did not say what the key deletes: one character (not half of a pair).
    const pair = (i: number) => i > 0 && i < this.text.length && /[\uD800-\uDBFF]/.test(this.text[i - 1]) && /[\uDC00-\uDFFF]/.test(this.text[i]);
    if (e.inputType.endsWith('Forward')) {
      const to = Math.min(this.text.length, start + (pair(start + 1) ? 2 : 1));
      return [start, to];
    }
    const from = Math.max(0, start - (pair(start - 1) ? 2 : 1));
    return [from, start];
  }

  // ---------- The element ----------

  /** Redraws the element from the text, changing as little of it as possible. */
  private render(): void {
    const el = this.element;
    const runs = textRuns(this.text, this.styled).map((run) => ({ text: run.text, className: runClass(run) }));
    // The line break an editable element needs to show an empty last line (it is not part of the text).
    const needsBreak = this.text === '' || this.text.endsWith('\n');
    const children = [...el.childNodes];
    const last = children[children.length - 1];
    const hasBreak = last instanceof HTMLBRElement;
    const content = hasBreak ? children.slice(0, -1) : children;
    const textOf = (node: Node, className: string): Text | undefined => {
      if (!className) return node instanceof Text ? node : undefined;
      if (!(node instanceof HTMLSpanElement) || node.className !== className || node.childNodes.length !== 1) return undefined;
      return node.firstChild instanceof Text ? node.firstChild : undefined;
    };
    const nodes = content.length === runs.length ? runs.map((run, i) => textOf(content[i], run.className)) : [];
    if (runs.length === 0 || nodes.length !== runs.length || nodes.some((node) => !node)) {
      el.replaceChildren(...runs.map((run) => runNode(run.text, run.className)), ...(needsBreak ? [document.createElement('br')] : []));
      return;
    }
    runs.forEach((run, i) => setData(nodes[i]!, run.text));
    if (needsBreak && !hasBreak) el.append(document.createElement('br'));
    else if (!needsBreak && hasBreak) last.remove();
  }

  /** Where a position of the element is in the text. */
  private offsetOf(node: Node, offset: number): number {
    const range = document.createRange();
    range.setStart(this.element, 0);
    range.setEnd(node, offset);
    return Math.min(this.text.length, range.toString().length);
  }

  /** The position in the element of an offset in the text. */
  private positionOf(offset: number): [Node, number] {
    const nodes = textNodes(this.element);
    for (const { node, start } of nodes) if (offset <= start + node.length) return [node, offset - start];
    const last = nodes[nodes.length - 1];
    return last ? [last.node, last.node.length] : [this.element, 0];
  }

  private select(anchor: number, focus: number): void {
    this.anchor = anchor;
    this.focusAt = focus;
    const selection = window.getSelection();
    if (!selection || document.activeElement !== this.element) return;
    const [aNode, aOffset] = this.positionOf(anchor);
    const [fNode, fOffset] = this.positionOf(focus);
    selection.setBaseAndExtent(aNode, aOffset, fNode, fOffset);
  }

  private readSelection(): [number, number] | undefined {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) return undefined;
    if (!this.element.contains(selection.anchorNode) || !this.element.contains(selection.focusNode)) return undefined;
    return [this.offsetOf(selection.anchorNode, selection.anchorOffset), this.offsetOf(selection.focusNode, selection.focusOffset)];
  }

  private onSelectionChange(): void {
    if (!this.open || this.composing) return;
    const selection = this.readSelection();
    if (!selection || (selection[0] === this.anchor && selection[1] === this.focusAt)) return;
    [this.anchor, this.focusAt] = selection;
    // The caret moved: typing continues in the style found there (a selection: in that of its start).
    this.typing = selection[0] === selection[1] ? this.styleBefore(selection[0]) : styleAt(this.styled, Math.min(...selection));
    this.lastEdit = undefined;
    this.events.selection();
  }
}
