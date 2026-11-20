// The glossary in the viewer: the terms the reader defined in this document, every place where
// each of them is written (marked with a dotted line under it, on a layer of its own under the
// text), and the two popovers: the one that says what a term means, and the one a term is
// defined in.
//   Glossary · written 12 times            Term
//   MLP                                    [MLP                         ]
//   Multi-Layer Perceptron                 What it means
//   [✎ Edit] [🗑 Delete]                    [Multi-Layer Perceptron      ]
//                                          Ctrl+Enter to save   [Cancel] [Save]
// Where the terms are written is found again whenever the document or the glossary changes (it is
// a search in the text, not something stored).
import {
  MAX_DEFINITION_LENGTH,
  MAX_TERM_LENGTH,
  countMatches,
  findTerms,
  firstMatchIn,
  sortTerms,
  termKey,
  termsWrittenIn,
  type GlossaryTerm,
  type TermMatch,
} from '../src/shared/glossary';
import { MOD_KEY, h, icon, labelButton, placeFloating } from './dom';
import type { Frac, HighlightController } from './highlights';
import type { PageLayers } from './pageLayers';
import type { Viewer } from './viewer';

const TERM_LAYER = 'mpv-term-layer';
/** How long the place a row of the list went to stays marked. */
const FLASH_MS = 1800;

interface DrawnTerm {
  /** Which place (an index into the places found). */
  index: number;
  id: string;
  rects: Frac[];
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A marked term under a point of the screen. */
export interface TermHit {
  id: string;
  /** Which of the places where it is written. */
  index: number;
  rect: ScreenRect;
}

export interface GlossaryEvents {
  /** The terms, or how often they are written, changed (the list shows them). */
  changed(): void;
}

export class GlossaryController {
  private readonly terms = new Map<string, GlossaryTerm>();
  /** Every place where a term is written in the document shown, in the order of the text. */
  private matches: TermMatch[] = [];
  private counts = new Map<string, number>();
  /** What is drawn on each page that is rendered: what a click or the pointer is tested against. */
  private readonly drawn = new Map<number, DrawnTerm[]>();
  private hovered?: number;
  private flashed?: number;
  private flashTimer?: ReturnType<typeof setTimeout>;
  /** The place the next "go to" of a term goes to (it goes through them in turn). */
  private readonly nextPlace = new Map<string, number>();

  constructor(
    private readonly viewer: Viewer,
    private readonly layers: PageLayers,
    private readonly highlights: HighlightController,
    private readonly events: GlossaryEvents,
  ) {
    layers.register({ className: TERM_LAYER, placement: 'above-canvas', fill: (layer, i) => this.fillLayer(layer, i) });
    // (After the highlights' own handler, which is what reads the text layer that was rendered.)
    viewer.eventBus.on('textlayerrendered', (evt: { pageNumber: number }) => this.layers.redraw(TERM_LAYER, evt.pageNumber - 1));
    highlights.onDocument = () => this.refresh();
  }

  // ---------- The terms ----------

  /** Replaces the whole glossary (the document was opened, or its annotations were read again). */
  setTerms(list: readonly GlossaryTerm[]): void {
    this.terms.clear();
    for (const term of list) this.terms.set(term.id, structuredClone(term));
    this.refresh();
  }

  /** The terms, by the alphabet. */
  get all(): GlossaryTerm[] {
    return sortTerms([...this.terms.values()]);
  }

  get size(): number {
    return this.terms.size;
  }

  get(id: string): GlossaryTerm | undefined {
    return this.terms.get(id);
  }

  /** The term that is written in the same places as `term`, if the glossary has one. */
  byKey(term: string): GlossaryTerm | undefined {
    const key = termKey(term);
    for (const other of this.terms.values()) if (termKey(other.term) === key) return other;
    return undefined;
  }

  /** Adds a term, or a new version of one. A document has one definition per term: another with its key gives way. */
  put(term: GlossaryTerm): void {
    const other = this.byKey(term.term);
    if (other && other.id !== term.id) this.terms.delete(other.id);
    this.terms.set(term.id, structuredClone(term));
    this.refresh();
  }

  remove(id: string): void {
    if (this.terms.delete(id)) this.refresh();
  }

  /** How many times a term is written in the document shown. */
  count(id: string): number {
    return this.counts.get(id) ?? 0;
  }

  /** Those of `terms` (of other documents) that are written in the document shown. */
  writtenHere(terms: readonly string[]): string[] {
    const text = this.highlights.textModel?.text;
    return text ? termsWrittenIn(text, terms) : [];
  }

  /** Looks for every term in the text of the document shown, and draws what was found. */
  private refresh(): void {
    const text = this.highlights.textModel?.text ?? '';
    this.matches = findTerms(text, [...this.terms.values()]);
    this.counts = countMatches(this.matches);
    this.drawn.clear();
    this.nextPlace.clear();
    this.hovered = undefined;
    this.flashed = undefined;
    this.layers.redraw(TERM_LAYER);
    this.events.changed();
  }

  // ---------- Drawing ----------

  private fillLayer(layer: HTMLElement, pageIndex: number): void {
    layer.replaceChildren();
    this.drawn.delete(pageIndex);
    const model = this.highlights.textModel;
    if (!model || this.matches.length === 0 || pageIndex >= model.pageCount) return;
    const from = model.pageStart[pageIndex];
    const to = model.pageStart[pageIndex + 1];
    /** The height of the page on screen, measured when the first mark needs it. */
    let height: number | undefined;
    const drawn: DrawnTerm[] = [];
    const boxes: HTMLElement[] = [];
    for (let i = firstMatchIn(this.matches, from); i < this.matches.length && this.matches[i].start < to; i++) {
      const match = this.matches[i];
      const rects = this.highlights.liveRects(match.start, match.end, pageIndex);
      // The text of the page is not rendered yet: drawn when it is.
      if (rects === undefined) return;
      if (rects.length === 0) continue;
      height ??= this.viewer.pageView(pageIndex)?.div.getBoundingClientRect().height ?? 0;
      drawn.push({ index: i, id: match.id, rects });
      for (const [x1, y1, x2, y2] of rects) {
        const box = document.createElement('div');
        box.className = 'mpv-term';
        if (i === this.hovered) box.classList.add('mpv-hover');
        if (i === this.flashed) box.classList.add('mpv-flash');
        box.dataset.i = String(i);
        box.style.left = `${(x1 * 100).toFixed(4)}%`;
        box.style.top = `${(y1 * 100).toFixed(4)}%`;
        box.style.width = `${((x2 - x1) * 100).toFixed(4)}%`;
        box.style.height = `${((y2 - y1) * 100).toFixed(4)}%`;
        // The dotted line is as heavy as the text is large (it grows with the zoom).
        const line = Math.min(3, Math.max(1, (y2 - y1) * height * 0.08));
        box.style.setProperty('--mpv-term-line', `${line.toFixed(2)}px`);
        boxes.push(box);
      }
    }
    this.drawn.set(pageIndex, drawn);
    layer.append(...boxes);
  }

  /** The marked term under a point of the screen, if any. */
  hitTest(clientX: number, clientY: number): TermHit | undefined {
    if (this.matches.length === 0) return undefined;
    const pageIndex = this.viewer.pageIndexAt(clientX, clientY);
    const drawn = pageIndex === undefined ? undefined : this.drawn.get(pageIndex);
    const div = pageIndex === undefined ? undefined : this.viewer.pageView(pageIndex)?.div;
    if (!drawn || drawn.length === 0 || !div) return undefined;
    const box = div.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return undefined;
    const fx = (clientX - box.left) / box.width;
    const fy = (clientY - box.top) / box.height;
    const pad = 0.002;
    for (const term of drawn) {
      for (const [x1, y1, x2, y2] of term.rects) {
        if (fx < x1 - pad || fx > x2 + pad || fy < y1 - pad || fy > y2 + pad) continue;
        return {
          id: term.id,
          index: term.index,
          rect: { left: box.left + x1 * box.width, top: box.top + y1 * box.height, right: box.left + x2 * box.width, bottom: box.top + y2 * box.height },
        };
      }
    }
    return undefined;
  }

  /** Tints the place the pointer is on (or none). */
  setHover(index: number | undefined): void {
    if (index === this.hovered) return;
    this.hovered = index;
    for (const el of document.querySelectorAll('.mpv-term.mpv-hover')) el.classList.remove('mpv-hover');
    if (index === undefined) return;
    for (const el of document.querySelectorAll(`.mpv-term[data-i="${index}"]`)) el.classList.add('mpv-hover');
  }

  /** Where a place is on the screen (its first line), if its page is rendered. */
  screenRectOf(index: number): ScreenRect | undefined {
    for (const [pageIndex, drawn] of this.drawn) {
      const term = drawn.find((d) => d.index === index);
      const div = term ? this.viewer.pageView(pageIndex)?.div : undefined;
      if (!term || !div?.isConnected) continue;
      const box = div.getBoundingClientRect();
      const [x1, y1, x2, y2] = term.rects[0];
      return { left: box.left + x1 * box.width, top: box.top + y1 * box.height, right: box.left + x2 * box.width, bottom: box.top + y2 * box.height };
    }
    return undefined;
  }

  /**
   * Goes to a place where a term is written, and marks it for a moment: the first place, then,
   * each time it is asked again, the next one. Resolves with the place it went to (undefined when
   * the term is not written in this document).
   */
  async reveal(id: string): Promise<number | undefined> {
    const model = this.highlights.textModel;
    const places: number[] = [];
    this.matches.forEach((match, i) => {
      if (match.id === id) places.push(i);
    });
    if (!model || places.length === 0) return undefined;
    const turn = (this.nextPlace.get(id) ?? 0) % places.length;
    this.nextPlace.set(id, turn + 1);
    const index = places[turn];
    const match = this.matches[index];
    const rects = await this.highlights.rangeRects(match.start, match.end);
    // (The glossary or the document changed while the page was read.)
    if (this.matches[index] !== match) return undefined;
    const first = rects[0];
    const page = first?.pageIndex ?? model.pageOf(match.start);
    const top = first ? Math.min(...first.rects.map((r) => r[1])) : 0;
    this.flashed = index;
    if (!this.viewer.scrollToFraction(page, top, 0.3)) this.viewer.goToPage(page + 1);
    this.layers.redraw(TERM_LAYER, page);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashed = undefined;
      for (const el of document.querySelectorAll('.mpv-term.mpv-flash')) el.classList.remove('mpv-flash');
    }, FLASH_MS);
    return index;
  }
}

// ---------- What a term means ----------

export interface TermPopoverActions {
  /** Change the term or what it means (the editor opens where this popover was). */
  edit(id: string, x: number, y: number): void;
  remove(id: string): void;
}

function timesWritten(count: number): string {
  return count === 0 ? 'not written in this document' : count === 1 ? 'written once' : `written ${count} times`;
}

/** Shown when a marked term is clicked: the term, what it means, then Edit and Delete. */
export class TermPopover {
  readonly element: HTMLElement;
  private readonly label = h('span', { class: 'mpv-term-popover-label' });
  private readonly name = h('span', { class: 'mpv-term-popover-name' });
  private readonly definition = h('div', { class: 'mpv-term-definition', dir: 'auto' });
  private currentId?: string;
  private anchor: [number, number] = [0, 0];

  constructor(actions: TermPopoverActions) {
    const edit = labelButton(icon('edit'), 'Edit', 'Change the term or what it means (Enter)');
    const remove = labelButton(icon('trash'), 'Delete', 'Delete this term from the glossary (Delete)', 'mpv-btn mpv-btn-label mpv-btn-danger');
    edit.addEventListener('click', () => {
      const id = this.currentId;
      const [x, y] = this.anchor;
      this.hide();
      if (id) actions.edit(id, x, y);
    });
    remove.addEventListener('click', () => {
      const id = this.currentId;
      this.hide();
      if (id) actions.remove(id);
    });
    this.element = h(
      'div',
      { class: 'mpv-popover mpv-term-popover', role: 'dialog', 'aria-label': 'Glossary term', hidden: true },
      h('div', { class: 'mpv-term-popover-title' }, this.label, this.name),
      this.definition,
      h('div', { class: 'mpv-popover-row' }, edit, remove),
    );
    document.body.append(this.element);
  }

  /** `count`: how many times the term is written in the document. */
  show(term: GlossaryTerm, count: number, x: number, y: number): void {
    this.currentId = term.id;
    this.anchor = [x, y];
    this.label.textContent = `Glossary · ${timesWritten(count)}`;
    this.name.textContent = term.term;
    this.definition.textContent = term.definition;
    this.definition.scrollTop = 0;
    placeFloating(this.element, x, y);
  }

  hide(): void {
    this.element.hidden = true;
    this.currentId = undefined;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  /** The term it shows (while it is open). */
  get termId(): string | undefined {
    return this.element.hidden ? undefined : this.currentId;
  }

  /** Where it was opened: its editor opens there too. */
  get position(): [number, number] {
    return this.anchor;
  }
}

// ---------- Defining a term ----------

export interface DefinePopoverActions {
  /**
   * Stores a new term (no `id`) or a changed one. Returns what keeps it from being stored (said
   * in the popover, which stays open), or undefined when it is stored.
   */
  save(id: string | undefined, term: string, definition: string): string | undefined;
  /** Something that was typed could not be kept (the popover closed with it). */
  notice(message: string): void;
}

function filledButton(text: string, primary: boolean): HTMLButtonElement {
  return h('button', { class: primary ? 'mpv-btn mpv-btn-primary' : 'mpv-btn mpv-btn-secondary', type: 'button' }, h('span', { class: 'mpv-label', text }));
}

/** Where a term is defined, or changed: the term, what it means, Cancel and Save. */
export class DefinePopover {
  readonly element: HTMLElement;
  private readonly term = h('input', {
    class: 'mpv-field mpv-define-term',
    id: 'mpv-define-term',
    type: 'text',
    maxlength: MAX_TERM_LENGTH,
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'A word, an acronym, a short phrase',
  });
  private readonly definition = h('textarea', {
    class: 'mpv-note-input',
    id: 'mpv-define-text',
    rows: 3,
    maxlength: MAX_DEFINITION_LENGTH,
    placeholder: 'What does it mean?',
  });
  private readonly problem = h('p', { class: 'mpv-define-problem', role: 'alert', hidden: true });
  private currentId?: string;
  private initial = { term: '', definition: '' };

  constructor(private readonly actions: DefinePopoverActions) {
    const save = filledButton('Save', true);
    const cancel = filledButton('Cancel', false);
    save.addEventListener('click', () => this.save());
    cancel.addEventListener('click', () => this.hide(false));
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.hide(false);
      } else if (e.key === 'Enter' && e.target === this.term) {
        // Enter in the one-line field goes on to what the term means.
        e.preventDefault();
        this.definition.focus();
      }
    };
    this.term.addEventListener('keydown', onKey);
    this.definition.addEventListener('keydown', onKey);
    const clear = (): void => {
      this.problem.hidden = true;
    };
    this.term.addEventListener('input', clear);
    this.definition.addEventListener('input', clear);
    this.element = h(
      'div',
      { class: 'mpv-popover mpv-define-popover', role: 'dialog', 'aria-label': 'Define a term', hidden: true },
      h('label', { class: 'mpv-note-label', for: 'mpv-define-term', text: 'Term' }),
      this.term,
      h('label', { class: 'mpv-note-label', for: 'mpv-define-text', text: 'What it means' }),
      this.definition,
      this.problem,
      h('div', { class: 'mpv-popover-row' }, h('span', { class: 'mpv-note-hint', text: `${MOD_KEY}+Enter to save` }), h('span', { class: 'mpv-grow' }), cancel, save),
    );
    document.body.append(this.element);
  }

  /** Opens for a new term (the text that was selected) or for one of the glossary (with its `id`). */
  show(source: { id?: string; term: string; definition?: string }, x: number, y: number): void {
    this.currentId = source.id;
    this.initial = { term: source.term, definition: source.definition ?? '' };
    this.term.value = source.term;
    this.definition.value = source.definition ?? '';
    this.problem.hidden = true;
    this.element.setAttribute('aria-label', source.id ? 'Edit a term' : 'Define a term');
    placeFloating(this.element, x, y);
    // The term is there already (what was selected): the reader goes on with what it means.
    const field = source.term ? this.definition : this.term;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }

  private get changed(): boolean {
    return this.term.value.trim() !== this.initial.term.trim() || this.definition.value.trim() !== this.initial.definition.trim();
  }

  /** Save: what cannot be stored is said here, and the popover stays open. */
  private save(): void {
    if (this.element.hidden) return;
    if (this.currentId && !this.changed) {
      this.close();
      return;
    }
    const problem = this.actions.save(this.currentId, this.term.value, this.definition.value);
    if (problem === undefined) {
      this.close();
      return;
    }
    this.problem.textContent = problem;
    this.problem.hidden = false;
    (this.term.value.trim() ? this.definition : this.term).focus({ preventScroll: true });
  }

  private close(): void {
    this.element.hidden = true;
    this.currentId = undefined;
  }

  /**
   * Closes the popover. With `commit` (a press elsewhere, another tool) what was typed is stored
   * if it can be; a definition that cannot be stored is said in a line at the bottom of the viewer.
   */
  hide(commit = true): void {
    if (this.element.hidden) return;
    const id = this.currentId;
    const term = this.term.value;
    const definition = this.definition.value;
    const changed = this.changed;
    this.close();
    if (!commit || !changed || !definition.trim()) return;
    const problem = this.actions.save(id, term, definition);
    if (problem !== undefined) this.actions.notice(`Not saved. ${problem}`);
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  contains(node: Node | null): boolean {
    return !!node && this.element.contains(node);
  }
}
