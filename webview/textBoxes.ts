// Text boxes in the viewer: how their text is styled, measured, shown and edited. The page shows
// a text box as HTML inside the page's SVG (a foreignObject in page units, so it zooms with the
// page), the editor is a textarea with the very same styles laid out at the same size and scaled
// to the zoom, and a hidden twin measures boxes: all three wrap lines identically.
import { TEXT_LINE_HEIGHT, TEXT_PAD_Y, type TextDrawing, type TextLayout, type TextStyle } from '../src/shared/drawings';
import { setInk } from './drawings';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

export interface BoxSize {
  width: number;
  height: number;
}

type Styled = Pick<TextDrawing, keyof TextStyle | 'boxWidth'>;

/** Gives an element (shown text, measurer or editor) the style of a text box. Sizes are in points. */
export function styleTextElement(el: HTMLElement, text: Styled): void {
  el.classList.add('mpv-text-body');
  setInk(el, text.color);
  el.style.setProperty('font-size', `${text.size}px`);
  el.style.setProperty('font-weight', text.bold ? '700' : '400');
  el.style.setProperty('font-style', text.italic ? 'italic' : 'normal');
  el.style.setProperty('text-decoration-line', text.underline ? 'underline' : 'none');
  el.style.setProperty('text-align', text.align);
  if (text.boxWidth === undefined) {
    el.style.setProperty('width', 'max-content');
    el.style.setProperty('white-space', 'pre');
  } else {
    el.style.setProperty('width', `${text.boxWidth}px`);
    el.style.setProperty('white-space', 'pre-wrap');
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
  measure(text: Styled & { text: string }): BoxSize {
    const el = this.prepare(text);
    const lines = this.lineCount(el, text.text);
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
  offsetAt(text: Styled & { text: string }, x: number, y: number): number {
    const el = this.prepare(text);
    const node = el.firstChild;
    if (!(node instanceof Text)) return 0;
    const origin = el.getBoundingClientRect();
    const range = document.createRange();
    let best = text.text.length;
    let bestScore = Infinity;
    const chars = [...text.text];
    let index = 0;
    for (const ch of chars) {
      const end = index + ch.length;
      if (ch !== '\n') {
        range.setStart(node, index);
        range.setEnd(node, end);
        const r = range.getClientRects()[0];
        if (r) {
          const top = r.top - origin.top;
          const bottom = r.bottom - origin.top;
          const dy = y < top ? top - y : y > bottom ? y - bottom : 0;
          const mid = r.left - origin.left + r.width / 2;
          const score = dy * 1000 + Math.abs(x - mid);
          if (score < bestScore) {
            bestScore = score;
            best = x < mid ? index : end;
          }
        }
      }
      index = end;
    }
    return best;
  }

  private prepare(text: Styled & { text: string }): HTMLDivElement {
    const el = this.el;
    el.className = 'mpv-text-measure';
    styleTextElement(el, text);
    // A last empty line still counts (an editor shows it).
    el.textContent = text.text;
    return el;
  }

  private lineCount(el: HTMLDivElement, text: string): number {
    if (text.length === 0) return 1;
    return this.lines(el, text).length;
  }

  /** Splits the shown text into its lines (soft wraps found from where each character is drawn). */
  private lines(el: HTMLDivElement, text: string): string[] {
    const node = el.firstChild;
    if (!(node instanceof Text)) return [''];
    const range = document.createRange();
    const lines: string[] = [];
    let start = 0;
    let lastTop: number | undefined;
    let index = 0;
    for (const ch of text) {
      const end = index + ch.length;
      if (ch === '\n') {
        lines.push(text.slice(start, index));
        start = end;
        lastTop = undefined;
      } else {
        range.setStart(node, index);
        range.setEnd(node, end);
        const rects = range.getClientRects();
        // A space where a line wraps can have no box or one at the end of the line before.
        const rect = rects[rects.length - 1];
        if (rect && rect.width > 0) {
          if (lastTop !== undefined && rect.top > lastTop + 1 && ch !== ' ') {
            lines.push(text.slice(start, index));
            start = index;
          }
          lastTop = rect.top;
        }
      }
      index = end;
    }
    lines.push(text.slice(start));
    return lines;
  }
}

/** The HTML that shows a text box on the page (inside its foreignObject). */
export function textContentElement(text: TextDrawing): HTMLDivElement {
  const div = document.createElementNS(XHTML_NS, 'div') as HTMLDivElement;
  styleTextElement(div, text);
  div.textContent = text.text;
  return div;
}

export interface EditorEvents {
  input(): void;
  /** Esc, or Ctrl/Cmd+Enter: done editing. */
  finish(): void;
}

/**
 * The textarea of the text box being edited: laid out in points like the shown text, scaled to
 * the zoom with a transform, and placed over the box inside the scrolling container (so it
 * scrolls with the page and survives PDF.js re-creating the page's layers).
 */
export class TextEditor {
  readonly textarea: HTMLTextAreaElement;

  constructor(
    private readonly container: HTMLElement,
    events: EditorEvents,
  ) {
    this.textarea = document.createElement('textarea');
    this.textarea.className = 'mpv-text-editor';
    this.textarea.spellcheck = true;
    this.textarea.setAttribute('aria-label', 'Text box');
    this.textarea.hidden = true;
    this.textarea.addEventListener('input', () => events.input());
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        e.stopPropagation();
        events.finish();
      } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '    ');
      }
    });
    container.append(this.textarea);
  }

  get open(): boolean {
    return !this.textarea.hidden;
  }

  get value(): string {
    return this.textarea.value;
  }

  show(text: Styled & { text: string }, caret?: number): void {
    this.textarea.value = text.text;
    this.restyle(text);
    this.textarea.hidden = false;
    this.textarea.focus({ preventScroll: true });
    const at = caret ?? text.text.length;
    this.textarea.setSelectionRange(at, at);
  }

  restyle(text: Styled): void {
    this.textarea.className = 'mpv-text-editor';
    styleTextElement(this.textarea, text);
    this.textarea.wrap = text.boxWidth === undefined ? 'off' : 'soft';
  }

  /** Places the editor: its top left corner (container content pixels), its size in points, the zoom. */
  place(left: number, top: number, size: BoxSize, scale: number): void {
    const s = this.textarea.style;
    s.left = `${left}px`;
    s.top = `${top}px`;
    s.width = `${size.width}px`;
    s.height = `${size.height}px`;
    s.transform = `scale(${scale})`;
    s.setProperty('--mpv-unscale', String(1 / scale));
  }

  focus(): void {
    if (this.open) this.textarea.focus({ preventScroll: true });
  }

  hide(): void {
    const hadFocus = document.activeElement === this.textarea;
    this.textarea.hidden = true;
    this.textarea.value = '';
    if (hadFocus) this.container.focus({ preventScroll: true });
  }
}
