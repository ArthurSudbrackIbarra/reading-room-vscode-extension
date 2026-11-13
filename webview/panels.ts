// The annotations list, popovers (highlight, note, drawing, text box, reading marker), the note
// tooltip, the selection bar, toast, banner and the status overlay.
import type { OrphanReason, ResolutionKind } from '../src/anchoring/anchor';
import type { BindingFlag } from '../src/anchoring/binding';
import { TOOL_NAMES, textStyleOf, type InkDrawing, type InkWidth, type TextDrawing, type TextStyle } from '../src/shared/drawings';
import { HIGHLIGHT_COLORS, HIGHLIGHT_HEX, MAX_NOTE_LENGTH, type Highlight, type HighlightColor, type ReadingMarker } from '../src/shared/types';
import { sanitizeSections, type ListSection } from '../src/shared/ui';
import { ColorButton } from './colorPicker';
import { h, icon, iconButton, labelButton, MOD_KEY, placeFloating, swatchButton } from './dom';
import { COLOR_NAMES, textStyleControls, widthRadios, type TextStyleControls, type WidthRadios } from './drawingBar';
import { setInk } from './drawings';
import { bookIcon, highlighterIcon, letterIcon } from './icons';
import { MenuButton } from './menu';

export { MOD_KEY };

export interface ListEntry {
  data: Highlight;
  page?: number;
  /** What the last render did to it. */
  kind?: ResolutionKind;
  /** Orphans: why its text was not found, and the page it was last on. */
  reason?: OrphanReason;
  wasPage?: number;
  /** The text it is on now, when that differs from what was highlighted. */
  now?: string;
  /** Orphans: the text that took the place of its text. */
  candidate?: string;
}

export interface MarkerEntry {
  marker: ReadingMarker;
  page: number;
  /** Set when the marker is not on its own line (the line is gone, or its text is not in this version). */
  caveat?: string;
}

/** What is known about a drawing or text box whose content is not in the document shown. */
export interface OrphanInfo {
  reason?: OrphanReason;
}

export interface DrawingEntry {
  data: InkDrawing;
  /** False when it is not shown: its content (or its page) is not in the document now. It is kept. */
  onPage: boolean;
  thumbnail: SVGSVGElement;
  orphan?: OrphanInfo;
  flags?: BindingFlag[];
}

export interface TextEntry {
  data: TextDrawing;
  onPage: boolean;
  orphan?: OrphanInfo;
  flags?: BindingFlag[];
}

/** Why an annotation is orphaned, as said in the list (also read by screen readers: never color alone). */
export const REASON_TEXT: Record<OrphanReason, string> = {
  deleted: 'its text was deleted',
  replaced: 'its text was replaced',
  'not-found': 'its text is not in this version of the file',
  'page-missing': 'its page is gone',
  invalid: 'its data could not be read',
};

const DRAWING_REASON_TEXT: Record<OrphanReason, string> = {
  deleted: 'what it was on was deleted',
  replaced: 'what it was on was replaced',
  'not-found': 'what it was on is not in this version of the file',
  'page-missing': 'its page is gone',
  invalid: 'its data could not be read',
};

const FLAG_TEXT: Record<BindingFlag, string> = {
  reflowed: 'its text wraps differently now',
  clipped: 'moved back inside the page',
  'needs-review': 'check its place',
};

function flagText(flags: BindingFlag[] | undefined): string {
  return (flags ?? []).map((f) => FLAG_TEXT[f]).join(', ');
}

export interface SidebarActions {
  reveal(id: string): void;
  remove(id: string): void;
  copy(text: string): void;
  editNote(id: string): void;
  goToMarker(): void;
  removeMarker(): void;
  /** Keeps a highlight on the text it is on now (after an edit or a partial deletion): its quote becomes that text. */
  accept(id: string): void;
  /** Puts an orphaned highlight on the selected text, or on the text that replaced its own. */
  attachSelection(id: string): void;
  attachCandidate(id: string): void;
  /** Deletes every orphaned highlight, drawing and text box (one undo step). */
  removeOrphans(): void;
  /** Drawings and text boxes. */
  revealDrawing(id: string): void;
  removeDrawing(id: string): void;
  /** Puts an orphaned drawing or text box back on the page (where its content was, or on the page shown). */
  placeDrawing(id: string): void;
  /** Keeps a flagged drawing or text box where it is shown now. */
  acceptDrawing(id: string): void;
  removeAllDrawings(): void;
  removeAllTextBoxes(): void;
  /** The reader collapsed or opened a section (remembered for all files). */
  sectionsChanged(collapsed: ListSection[]): void;
  close(): void;
}

function excerpt(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return '';
  return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `text` with every occurrence of `query` marked (ignoring case). */
function marked(text: string, query: string): (Node | string)[] {
  if (!query) return [text];
  const parts: (Node | string)[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(query); at >= 0; at = lower.indexOf(query, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(h('mark', { class: 'mpv-mark', text: text.slice(at, at + query.length) }));
    from = at + query.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/** A small button of a row: an icon and a label, or an icon alone. */
function rowAction(name: string, label: string | undefined, title: string, run: () => void, danger = false): HTMLButtonElement {
  const classes = `mpv-btn mpv-btn-sm${label ? ' mpv-btn-label' : ''}${danger ? ' mpv-btn-danger' : ''}`;
  const button = label ? labelButton(icon(name), label, title, classes) : iconButton(name, title, { class: classes });
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return button;
}

interface RowParts {
  /** What identifies the row while the list is redrawn. */
  key: string;
  className?: string;
  title: string;
  /** A thumbnail in place of the 16 px lead column. */
  thumb?: boolean;
  lead: Node;
  body: (Node | undefined)[];
  /** Decisions that are pending: always visible under the row. */
  pending?: HTMLElement[];
  /** What can be done with it: visible under the row while it is selected. */
  actions: (HTMLElement | undefined)[];
  /** The row was clicked (it is selected in every case). */
  activate?: () => void;
  /** Its text is not in the document: a click on the pages keeps the row selected (to attach it to a selection). */
  keepSelected?: boolean;
}

interface ListData {
  entries: ListEntry[];
  marker: MarkerEntry | null;
  drawings: DrawingEntry[];
  texts: TextEntry[];
}

/**
 * The annotations list: where the reader stopped, then the highlights, the orphaned ones, the
 * drawings and the text boxes, each in a section that can be collapsed. A search and filters
 * narrow the highlights. A click on a row goes to the annotation and selects the row: its actions
 * open under it (nothing depends on hover).
 */
export class Sidebar {
  readonly element: HTMLElement;
  private readonly list = h('div', { class: 'mpv-list' });
  private readonly count = h('span', { class: 'mpv-count', hidden: true });
  private readonly search = h('input', { type: 'text', spellcheck: 'false', placeholder: 'Search highlights and notes', 'aria-label': 'Search highlights and notes' });
  private readonly clearSearch = iconButton('close', 'Clear the search', { class: 'mpv-btn mpv-btn-sm', hidden: true });
  private readonly colorFilters = new Map<HighlightColor, HTMLButtonElement>();
  private readonly notesFilter = h(
    'button',
    { class: 'mpv-chip', type: 'button', title: 'Show only highlights with a note', 'aria-pressed': 'false' },
    icon('comment'),
    h('span', { class: 'mpv-label', text: 'With notes' }),
  );
  private readonly tools: HTMLElement;
  private data: ListData = { entries: [], marker: null, drawings: [], texts: [] };
  private query = '';
  private readonly colors = new Set<HighlightColor>();
  private withNotes = false;
  private readonly collapsed = new Set<ListSection>();
  private selected?: string;
  private keepSelected = false;

  constructor(private readonly actions: SidebarActions) {
    const close = iconButton('close', 'Close the list');
    close.addEventListener('click', () => actions.close());
    const filter = h('div', { class: 'mpv-filter', role: 'group', 'aria-label': 'Filter by color' });
    for (const color of HIGHLIGHT_COLORS) {
      const name = COLOR_NAMES[color];
      const button = swatchButton({ title: `Show only ${name.toLowerCase()} highlights`, 'aria-label': name, 'aria-pressed': 'false' }, true);
      button.style.setProperty('--swatch', HIGHLIGHT_HEX[color]);
      button.addEventListener('click', () => {
        if (!this.colors.delete(color)) this.colors.add(color);
        this.draw();
      });
      this.colorFilters.set(color, button);
      filter.append(button);
    }
    filter.append(this.notesFilter);
    this.notesFilter.addEventListener('click', () => {
      this.withNotes = !this.withNotes;
      this.draw();
    });
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.draw();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.search.value) return;
      e.preventDefault();
      e.stopPropagation();
      this.setSearch('');
    });
    this.clearSearch.addEventListener('click', () => {
      this.setSearch('');
      this.search.focus();
    });
    this.tools = h('div', { class: 'mpv-list-tools' }, h('label', { class: 'mpv-search' }, icon('search'), this.search, this.clearSearch), filter);
    this.element = h(
      'aside',
      { class: 'mpv-sidebar', 'aria-label': 'Annotations', hidden: true },
      h('div', { class: 'mpv-sidebar-header' }, h('span', { class: 'mpv-caps', text: 'Annotations' }), this.count, h('span', { class: 'mpv-grow' }), close),
      this.tools,
      this.list,
    );
    this.element.addEventListener('keydown', (e) => this.onKey(e));
    // A click elsewhere clears the selected row. (Not a click on the pages while the row is an
    // orphaned highlight: the reader selects the text to attach it to.)
    document.addEventListener('pointerdown', (e) => {
      const target = e.target as Element | null;
      if (!this.selected || this.element.contains(target)) return;
      if (this.keepSelected && target?.closest?.('.mpv-viewer-container')) return;
      this.select(undefined);
    });
  }

  set open(value: boolean) {
    this.element.hidden = !value;
    document.body.classList.toggle('mpv-sidebar-open', value);
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  /** The sections the reader left collapsed. */
  setCollapsed(sections: readonly string[]): void {
    this.collapsed.clear();
    for (const section of sanitizeSections(sections)) this.collapsed.add(section);
    this.draw();
  }

  render(entries: ListEntry[], marker: MarkerEntry | null, drawings: DrawingEntry[], texts: TextEntry[]): void {
    this.data = { entries, marker, drawings, texts };
    this.draw();
  }

  private get filtering(): boolean {
    return this.query !== '' || this.colors.size > 0 || this.withNotes;
  }

  private setSearch(value: string): void {
    this.search.value = value;
    this.query = value.trim().toLowerCase();
    this.draw();
  }

  private clearFilters(): void {
    this.colors.clear();
    this.withNotes = false;
    this.setSearch('');
  }

  private matches(entry: ListEntry): boolean {
    if (this.colors.size > 0 && !this.colors.has(entry.data.color)) return false;
    if (this.withNotes && !entry.data.note) return false;
    if (!this.query) return true;
    const text = `${entry.data.target.selector[0].exact}\n${entry.now ?? ''}\n${entry.data.note ?? ''}`;
    return text.toLowerCase().includes(this.query);
  }

  private draw(): void {
    const { entries, marker, drawings, texts } = this.data;
    const total = entries.length + drawings.length + texts.length;
    this.count.textContent = String(total);
    this.count.hidden = total === 0;
    // Nothing to search while the list is empty.
    this.tools.hidden = total === 0;
    this.clearSearch.hidden = this.search.value === '';
    for (const [color, button] of this.colorFilters) {
      const on = this.colors.has(color);
      button.classList.toggle('mpv-selected', on);
      button.setAttribute('aria-pressed', String(on));
    }
    this.notesFilter.classList.toggle('mpv-active', this.withNotes);
    this.notesFilter.setAttribute('aria-pressed', String(this.withNotes));

    const anchored = entries.filter((e) => e.data.status !== 'orphaned');
    const orphaned = entries.filter((e) => e.data.status === 'orphaned');
    const items: HTMLElement[] = [];
    const filtering = this.filtering && total > 0;
    this.keepSelected = false;

    if (filtering) {
      // Only the highlights that match; the rest of the list steps aside.
      const found = anchored.filter((e) => this.matches(e));
      const clear = h('button', { class: 'mpv-link', type: 'button', text: 'Clear filters' });
      clear.addEventListener('click', () => this.clearFilters());
      items.push(
        ...this.section(
          'highlights',
          'Highlights',
          `${found.length} of ${anchored.length}`,
          found.map((e) => this.item(e, false)),
          { action: clear },
        ),
      );
      if (found.length === 0) items.push(h('p', { class: 'mpv-list-note', text: 'No highlight matches.' }));
      items.push(h('p', { class: 'mpv-list-note', text: 'Drawings and text boxes are hidden while a search or filter is on.' }));
    } else {
      if (marker) items.push(h('ul', { class: 'mpv-list-marker' }, this.markerItem(marker)));
      if (total === 0) items.push(this.empty());
      if (anchored.length > 0) {
        items.push(
          ...this.section(
            'highlights',
            'Highlights',
            String(anchored.length),
            anchored.map((e) => this.item(e, false)),
          ),
        );
      }
      if (orphaned.length > 0) {
        const lost = orphaned.length + drawings.filter((d) => d.orphan).length + texts.filter((t) => t.orphan).length;
        const removeAll = iconButton('trash', `Delete all ${lost} orphaned annotations`, { class: 'mpv-btn mpv-btn-sm mpv-btn-danger' });
        removeAll.addEventListener('click', () => this.actions.removeOrphans());
        items.push(
          ...this.section(
            'orphaned',
            'Orphaned',
            String(orphaned.length),
            orphaned.map((e) => this.item(e, true)),
            { warn: true, action: removeAll, note: 'Their text is not in the document now. They are kept, and come back if the text returns.' },
          ),
        );
      }
      if (drawings.length > 0) {
        const removeAll = iconButton('trash', 'Delete all drawings…', { class: 'mpv-btn mpv-btn-sm mpv-btn-danger' });
        removeAll.addEventListener('click', () => this.actions.removeAllDrawings());
        items.push(
          ...this.section(
            'drawings',
            'Drawings',
            String(drawings.length),
            drawings.map((e) => this.drawingItem(e)),
            { action: removeAll },
          ),
        );
      }
      if (texts.length > 0) {
        const removeAll = iconButton('trash', 'Delete all text boxes…', { class: 'mpv-btn mpv-btn-sm mpv-btn-danger' });
        removeAll.addEventListener('click', () => this.actions.removeAllTextBoxes());
        items.push(
          ...this.section(
            'texts',
            'Text boxes',
            String(texts.length),
            texts.map((e) => this.textItem(e)),
            { action: removeAll },
          ),
        );
      }
    }
    // The row that had the keyboard keeps it (the list is rebuilt whenever something changes).
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.mpv-row')?.dataset.key;
    this.list.replaceChildren(...items);
    if (this.selected && !this.rowOf(this.selected)) this.selected = undefined;
    if (focused) this.rowOf(focused)?.querySelector<HTMLElement>('.mpv-row-main')?.focus({ preventScroll: true });
  }

  /** A section: its header (a button that collapses it, its count, its action), a note, and its rows. */
  private section(key: ListSection, label: string, count: string, rows: HTMLElement[], options: { warn?: boolean; action?: HTMLElement; note?: string } = {}): HTMLElement[] {
    const open = !this.collapsed.has(key);
    const toggle = h(
      'button',
      { class: 'mpv-sec-toggle', type: 'button', 'aria-expanded': String(open), title: open ? `Collapse ${label.toLowerCase()}` : `Show ${label.toLowerCase()}` },
      icon(open ? 'chevron-down' : 'chevron-right'),
      options.warn ? icon('warning') : undefined,
      h('span', { class: 'mpv-caps', text: label }),
      h('span', { class: 'mpv-count', text: count }),
    );
    toggle.addEventListener('click', () => {
      if (!this.collapsed.delete(key)) this.collapsed.add(key);
      this.actions.sectionsChanged([...this.collapsed]);
      this.draw();
      this.list.querySelector<HTMLElement>(`.mpv-sec[data-section="${key}"] .mpv-sec-toggle`)?.focus();
    });
    const header = h('div', { class: options.warn ? 'mpv-sec mpv-sec-warn' : 'mpv-sec', 'data-section': key }, toggle, options.action);
    if (!open) return [header];
    const parts: HTMLElement[] = [header];
    if (options.note) parts.push(h('p', { class: 'mpv-list-note', text: options.note }));
    if (rows.length > 0) parts.push(h('ul', {}, ...rows));
    return parts;
  }

  private empty(): HTMLElement {
    const step = (glyph: Node, text: string): HTMLElement => h('li', {}, glyph, h('span', { text }));
    return h(
      'div',
      { class: 'mpv-empty' },
      bookIcon(40),
      h('p', { class: 'mpv-empty-title', text: 'Nothing marked yet' }),
      h('p', { class: 'mpv-empty-text', text: 'Your highlights, notes, drawings and text boxes are listed here, and so is the line where you stopped.' }),
      h(
        'ul',
        { class: 'mpv-empty-steps' },
        step(highlighterIcon(), 'Select text on a page to highlight it.'),
        step(icon('comment'), 'Click a highlight to write a note on it.'),
        step(icon('bookmark'), 'Use the bookmark to mark where you stopped.'),
      ),
    );
  }

  // ---------- Rows ----------

  private rowOf(key: string): HTMLElement | undefined {
    return [...this.list.querySelectorAll<HTMLElement>('.mpv-row')].find((row) => row.dataset.key === key);
  }

  /** Selects a row (its actions open under it), or none. */
  private select(key: string | undefined): void {
    this.selected = key;
    for (const row of this.list.querySelectorAll<HTMLElement>('.mpv-row')) {
      const on = row.dataset.key === key;
      row.classList.toggle('mpv-selected', on);
      const main = row.querySelector('.mpv-row-main');
      if (on) main?.setAttribute('aria-current', 'true');
      else main?.removeAttribute('aria-current');
      const actions = row.querySelector<HTMLElement>('.mpv-row-menu');
      if (actions) actions.hidden = !on;
      if (on) this.keepSelected = row.dataset.keep === 'true';
    }
    if (!key) this.keepSelected = false;
  }

  private row(parts: RowParts): HTMLElement {
    const on = parts.key === this.selected;
    const main = h(
      'button',
      { class: parts.thumb ? 'mpv-row-main mpv-row-main-thumb' : 'mpv-row-main', type: 'button', title: parts.title, 'aria-current': on ? 'true' : undefined },
      parts.lead,
      h('span', { class: 'mpv-row-body' }, ...parts.body),
    );
    main.addEventListener('click', () => {
      this.select(parts.key);
      parts.activate?.();
    });
    const under = parts.thumb ? 'mpv-row-actions mpv-row-actions-thumb' : 'mpv-row-actions';
    const row = h(
      'li',
      { class: `mpv-row${parts.className ? ` ${parts.className}` : ''}${on ? ' mpv-selected' : ''}`, 'data-key': parts.key, 'data-keep': parts.keepSelected ? 'true' : undefined },
      main,
      parts.pending && parts.pending.length > 0 ? h('div', { class: under }, ...parts.pending) : undefined,
      h('div', { class: `${under} mpv-row-menu`, hidden: !on }, ...parts.actions),
    );
    if (on && parts.keepSelected) this.keepSelected = true;
    return row;
  }

  /** Delete on a row deletes what it shows (its last action is its delete button); Esc clears the selection. */
  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.selected && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      e.stopPropagation();
      this.select(undefined);
      return;
    }
    if (e.key !== 'Delete' || e.ctrlKey || e.metaKey || e.altKey) return;
    const row = e.target instanceof HTMLElement && e.target.classList.contains('mpv-row-main') ? e.target.closest<HTMLElement>('.mpv-row') : undefined;
    const remove = row?.querySelector<HTMLButtonElement>('.mpv-row-menu > button:last-child');
    if (!row || !remove) return;
    e.preventDefault();
    e.stopPropagation();
    // The keyboard goes to the row that takes this one's place.
    const rows = [...this.list.querySelectorAll<HTMLElement>('.mpv-row')];
    const index = rows.indexOf(row);
    remove.click();
    requestAnimationFrame(() => {
      const next = [...this.list.querySelectorAll<HTMLElement>('.mpv-row-main')];
      (next[Math.min(index, next.length - 1)] ?? this.element).focus();
    });
  }

  private markerItem(entry: MarkerEntry): HTMLElement {
    const date = formatDate(entry.marker.createdAt);
    const quote = entry.marker.selector?.[0].exact;
    return this.row({
      key: 'marker',
      title: 'Go to where you stopped reading',
      lead: h('span', { class: 'mpv-row-lead' }, icon('bookmark')),
      body: [
        h('span', { class: 'mpv-row-text', text: quote ? `Where you stopped: “${excerpt(quote, 80)}”` : 'Where you stopped reading' }),
        h('span', { class: 'mpv-row-meta', text: [`Page ${entry.page + 1}`, date, entry.caveat ? 'about here: its line is not in this version' : ''].filter(Boolean).join(' · ') }),
      ],
      actions: [rowAction('close', 'Remove', 'Remove the reading marker', () => this.actions.removeMarker(), true)],
      activate: () => this.actions.goToMarker(),
    });
  }

  private item(entry: ListEntry, orphaned: boolean): HTMLElement {
    const id = entry.data.id;
    const quote = entry.data.target.selector[0].exact;
    const note = entry.data.note;
    const query = this.filtering ? this.query : '';
    const dot = h('span', { class: orphaned ? 'mpv-dot mpv-dot-sm mpv-dot-orphan' : 'mpv-dot mpv-dot-sm' });
    dot.style.setProperty('--swatch', HIGHLIGHT_HEX[entry.data.color]);
    const changed = !orphaned && entry.now !== undefined && (entry.kind === 'edited' || entry.kind === 'partial');
    const where = entry.page !== undefined ? `Page ${entry.page + 1}` : '';
    const status = orphaned
      ? [capitalize(REASON_TEXT[entry.reason ?? 'not-found']), entry.wasPage !== undefined ? `was on page ${entry.wasPage + 1}` : '']
      : [where, entry.kind === 'edited' ? 'its text changed' : entry.kind === 'partial' ? 'part of its text was deleted' : entry.kind === 'moved' ? 'moved with its text' : ''];
    const remove = rowAction('trash', undefined, 'Delete highlight', () => this.actions.remove(id), true);
    const editNote = (label: string | undefined): HTMLButtonElement => rowAction('comment', label, note ? 'Edit the note' : 'Add a note', () => this.actions.editNote(id));
    const grow = (): HTMLElement => h('span', { class: 'mpv-grow' });
    return this.row({
      key: `h:${id}`,
      className: orphaned ? 'mpv-orphan' : changed ? 'mpv-changed' : undefined,
      title: orphaned ? `Orphaned: ${REASON_TEXT[entry.reason ?? 'not-found']}. It is kept, and comes back if the text returns.` : 'Go to highlight',
      lead: h('span', { class: 'mpv-row-lead' }, dot),
      body: [
        changed
          ? h('span', { class: 'mpv-row-text' }, h('span', { class: 'mpv-tag', text: 'Changed' }), h('span', { class: 'mpv-row-old', text: excerpt(quote, 110) }))
          : h('span', { class: 'mpv-row-text' }, ...marked(excerpt(quote), query)),
        changed ? h('span', { class: 'mpv-row-text' }, ...marked(excerpt(entry.now ?? '', 110), query)) : undefined,
        note ? h('span', { class: 'mpv-note' }, icon('comment'), h('span', { class: 'mpv-note-text' }, ...marked(excerpt(note, 220), query))) : undefined,
        h('span', { class: 'mpv-row-meta', text: status.filter(Boolean).join(' · ') }),
      ],
      // A changed highlight waits for a decision: its action shows without selecting the row.
      pending: changed ? [rowAction('check', 'Keep as it is now', 'Keep it on the text as it is now', () => this.actions.accept(id))] : [],
      actions: orphaned
        ? [
            entry.candidate
              ? rowAction('replace', 'Attach to new text', `Attach to “${excerpt(entry.candidate, 60)}”, the text that replaced it`, () => this.actions.attachCandidate(id))
              : undefined,
            rowAction('link', 'Attach to selection', 'Attach to the text you have selected', () => this.actions.attachSelection(id)),
            rowAction('copy', undefined, 'Copy the highlighted text', () => this.actions.copy(quote)),
            editNote(undefined),
            grow(),
            remove,
          ]
        : [editNote(note ? 'Edit note' : 'Add note'), rowAction('copy', 'Copy', 'Copy the highlighted text', () => this.actions.copy(quote)), grow(), remove],
      activate: orphaned ? undefined : () => this.actions.reveal(id),
      keepSelected: orphaned,
    });
  }

  private drawingItem(entry: DrawingEntry): HTMLElement {
    return this.drawingRow(entry, 'drawing', h('span', { class: 'mpv-thumb' }, entry.thumbnail), TOOL_NAMES[entry.data.tool]);
  }

  private textItem(entry: TextEntry): HTMLElement {
    const thumb = h('span', { class: 'mpv-thumb mpv-text-thumb' }, letterIcon());
    setInk(thumb, entry.data.color);
    return this.drawingRow(entry, 'text box', thumb, excerpt(entry.data.text, 90));
  }

  /** A drawing or text box: its thumbnail, what it is, its page; why it is not shown, or what to check. */
  private drawingRow(entry: DrawingEntry | TextEntry, what: string, thumb: HTMLElement, text: string): HTMLElement {
    const id = entry.data.id;
    const page = `page ${entry.data.pageIndex + 1}`;
    const flags = flagText(entry.flags);
    let meta = capitalize(page);
    let title = `Go to ${what}`;
    const pending: HTMLElement[] = [];
    if (!entry.onPage) {
      const reason = DRAWING_REASON_TEXT[entry.orphan?.reason ?? 'page-missing'];
      meta = `${capitalize(reason)} · was on ${page}`;
      title = `Not shown: ${reason}. It is kept until you delete it, and comes back if its content returns.`;
      pending.push(rowAction('location', 'Put back on the page', `Put this ${what} back on the page`, () => this.actions.placeDrawing(id)));
    } else if (flags) {
      meta = `${capitalize(page)} · ${flags}`;
      title = `Go to ${what} (${flags})`;
      pending.push(rowAction('check', 'Keep it here', `Keep this ${what} where it is now`, () => this.actions.acceptDrawing(id)));
    }
    return this.row({
      key: `d:${id}`,
      className: entry.onPage ? undefined : 'mpv-orphan',
      title,
      thumb: true,
      lead: thumb,
      body: [
        h('span', { class: 'mpv-row-text' }, entry.onPage ? undefined : h('span', { class: 'mpv-tag', text: 'Not shown' }), text),
        h('span', { class: 'mpv-row-meta', text: meta }),
      ],
      pending,
      actions: [rowAction('trash', 'Delete', `Delete ${what}`, () => this.actions.removeDrawing(id), true)],
      activate: entry.onPage ? () => this.actions.revealDrawing(id) : undefined,
    });
  }
}

/** The five highlight colors as dots to pick from (in a popover row). */
function highlightSwatches(title: (name: string) => string, pick: (color: HighlightColor) => void): Map<HighlightColor, HTMLButtonElement> {
  const swatches = new Map<HighlightColor, HTMLButtonElement>();
  for (const color of HIGHLIGHT_COLORS) {
    const name = COLOR_NAMES[color];
    const swatch = swatchButton({ title: title(name), 'aria-label': title(name), 'aria-pressed': 'false', 'data-color': color });
    swatch.style.setProperty('--swatch', HIGHLIGHT_HEX[color]);
    swatch.addEventListener('click', () => pick(color));
    swatches.set(color, swatch);
  }
  return swatches;
}

function markSwatch(swatches: Map<HighlightColor, HTMLButtonElement>, color: HighlightColor | undefined): void {
  for (const [c, swatch] of swatches) {
    swatch.classList.toggle('mpv-selected', c === color);
    swatch.setAttribute('aria-pressed', String(c === color));
  }
}

const sep = (): HTMLElement => h('span', { class: 'mpv-sep' });

/** A filled button with a label: Save, Open, Retry (primary), or Cancel, Show log (secondary). */
function filledButton(text: string, primary: boolean, type: 'button' | 'submit' = 'button'): HTMLButtonElement {
  return h('button', { class: primary ? 'mpv-btn mpv-btn-primary' : 'mpv-btn mpv-btn-secondary', type }, h('span', { class: 'mpv-label', text }));
}

export interface PopoverActions {
  setColor(id: string, color: HighlightColor): void;
  remove(id: string): void;
  copy(id: string): void;
  saveNote(id: string, note: string): void;
  /** The popover of this highlight closed. */
  hidden(id: string): void;
}

/**
 * Shown when clicking a highlight: its color, then note and copy, then delete. A note shows under
 * the row; writing it grows the same popover in place.
 */
export class HighlightPopover {
  readonly element: HTMLElement;
  private currentId?: string;
  private note = '';
  private anchor: [number, number] = [0, 0];
  private readonly swatches: Map<HighlightColor, HTMLButtonElement>;
  private readonly noteButton = iconButton('comment', 'Add a note');
  private readonly noteText = h('span', { class: 'mpv-note-text' });
  private readonly noteView = h('button', { class: 'mpv-note mpv-note-view', type: 'button', title: 'Edit the note', hidden: true }, icon('comment'), this.noteText);
  private readonly textarea = h('textarea', {
    class: 'mpv-note-input',
    id: 'mpv-note-input',
    rows: 3,
    maxlength: MAX_NOTE_LENGTH,
    placeholder: 'Why is this highlighted? Write a note…',
  });
  private readonly editor: HTMLElement;

  constructor(private readonly actions: PopoverActions) {
    this.swatches = highlightSwatches(
      (name) => `Change to ${name.toLowerCase()}`,
      (color) => {
        if (this.currentId) actions.setColor(this.currentId, color);
        markSwatch(this.swatches, color);
        if (!this.editing) this.hide();
      },
    );
    this.noteButton.addEventListener('click', () => this.startEditing());
    const copy = iconButton('copy', 'Copy text');
    copy.addEventListener('click', () => {
      if (this.currentId) actions.copy(this.currentId);
      this.hide();
    });
    const remove = iconButton('trash', 'Delete highlight', { class: 'mpv-btn mpv-btn-danger' });
    remove.addEventListener('click', () => {
      const id = this.currentId;
      this.hide(false);
      if (id) actions.remove(id);
    });
    const row = h('div', { class: 'mpv-popover-row' }, ...this.swatches.values(), sep(), this.noteButton, copy, sep(), remove);
    this.noteView.addEventListener('click', () => this.startEditing());

    const save = filledButton('Save', true);
    const cancel = filledButton('Cancel', false);
    save.addEventListener('click', () => this.hide(true));
    cancel.addEventListener('click', () => this.hide(false));
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.hide(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.hide(false);
      }
    });
    this.editor = h(
      'div',
      { class: 'mpv-note-editor', hidden: true },
      h('label', { class: 'mpv-note-label', for: 'mpv-note-input', text: 'Note on this highlight' }),
      this.textarea,
      h('div', { class: 'mpv-popover-row' }, h('span', { class: 'mpv-note-hint', text: `${MOD_KEY}+Enter to save` }), h('span', { class: 'mpv-grow' }), cancel, save),
    );
    this.element = h('div', { class: 'mpv-popover mpv-hl-popover', role: 'dialog', 'aria-label': 'Edit highlight', hidden: true }, row, this.noteView, this.editor);
    document.body.append(this.element);
  }

  show(id: string, data: { color: HighlightColor; note?: string }, x: number, y: number, options: { editNote?: boolean } = {}): void {
    this.currentId = id;
    this.note = data.note ?? '';
    this.anchor = [x, y];
    markSwatch(this.swatches, data.color);
    this.noteButton.title = this.note ? 'Edit the note' : 'Add a note';
    this.noteButton.setAttribute('aria-label', this.noteButton.title);
    this.noteText.textContent = this.note;
    this.noteView.hidden = !this.note;
    this.editor.hidden = true;
    this.element.classList.remove('mpv-editing');
    placeFloating(this.element, x, y);
    if (options.editNote) this.startEditing();
  }

  /** Opens the note for writing (Enter on the selected highlight). */
  editNote(): void {
    if (this.visible && !this.editing) this.startEditing();
  }

  get editing(): boolean {
    return !this.element.hidden && !this.editor.hidden;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  get highlightId(): string | undefined {
    return this.currentId;
  }

  private startEditing(): void {
    if (!this.currentId) return;
    this.textarea.value = this.note;
    this.noteView.hidden = true;
    this.editor.hidden = false;
    this.element.classList.add('mpv-editing');
    placeFloating(this.element, this.anchor[0], this.anchor[1]);
    this.textarea.focus();
    this.textarea.setSelectionRange(this.textarea.value.length, this.textarea.value.length);
  }

  /** Closes the popover. While editing, `commit` saves a changed note (clicking elsewhere saves too). */
  hide(commit = true): void {
    if (this.element.hidden) return;
    const id = this.currentId;
    const editing = !this.editor.hidden;
    const value = this.textarea.value.replace(/\s+$/, '');
    this.element.hidden = true;
    this.editor.hidden = true;
    this.currentId = undefined;
    if (editing && commit && id && value !== this.note.replace(/\s+$/, '')) this.actions.saveNote(id, value);
    if (id) this.actions.hidden(id);
  }
}

/** What a drawing or text box follows when the document changes. */
export type Attachment = 'text' | 'image' | 'page';

/** The button of a selected drawing or text box that says what it follows, and opens the menu to choose. */
function attachMenu(onPick: (to: Attachment) => void): { element: HTMLElement; set(to: Attachment): void } {
  const button = new MenuButton<Attachment>({
    label: 'What it follows when the document changes',
    className: 'mpv-attach-select',
    head: 'When the document changes',
    options: [
      { value: 'text', label: 'Follows text' },
      { value: 'image', label: 'Follows image' },
      { value: 'page', label: 'Stays on page' },
    ],
    onPick,
  });
  return { element: button.element, set: (to) => button.setValue(to) };
}

export interface DrawingPopoverActions {
  /** Opens (or closes) the color picker for the drawing's ink, under `anchor`. */
  pickColor(id: string, anchor: HTMLElement): void;
  setWidth(id: string, width: InkWidth): void;
  /** The reader chose what the drawing follows. */
  attach(id: string, to: Attachment): void;
  /** Copies it (it is the selection). */
  copy(id: string): void;
  remove(id: string): void;
}

/** Shown when a drawing is selected: its ink, its width, what it follows, delete. It stays open while changing them. */
export class DrawingPopover {
  readonly element: HTMLElement;
  readonly color: ColorButton;
  private currentId?: string;
  private readonly widths: WidthRadios;
  private readonly attached: ReturnType<typeof attachMenu>;

  /** Shows what the drawing follows. */
  setAttached(to: Attachment): void {
    this.attached.set(to);
  }

  constructor(actions: DrawingPopoverActions) {
    this.attached = attachMenu((to) => {
      if (this.currentId) actions.attach(this.currentId, to);
    });
    this.color = new ColorButton('Ink color', (anchor) => {
      if (this.currentId) actions.pickColor(this.currentId, anchor);
    });
    this.widths = widthRadios((width) => {
      if (this.currentId) actions.setWidth(this.currentId, width);
    });
    const copy = iconButton('copy', `Copy drawing (${MOD_KEY}+C)`);
    copy.addEventListener('click', () => {
      if (this.currentId) actions.copy(this.currentId);
    });
    const remove = iconButton('trash', 'Delete drawing (Delete)', { class: 'mpv-btn mpv-btn-danger' });
    remove.addEventListener('click', () => {
      const id = this.currentId;
      this.hide();
      if (id) actions.remove(id);
    });
    const row = h('div', { class: 'mpv-popover-row mpv-wraps' }, this.color.element, this.widths.group, this.attached.element, copy, sep(), remove);
    // Esc reaches the viewer's handler, which deselects the drawing (and so closes this).
    this.element = h('div', { class: 'mpv-popover mpv-drawing-popover', role: 'dialog', 'aria-label': 'Edit drawing', hidden: true }, row);
    document.body.append(this.element);
  }

  show(drawing: Pick<InkDrawing, 'id' | 'color' | 'width'>, x: number, y: number): void {
    this.currentId = drawing.id;
    this.update(drawing);
    placeFloating(this.element, x, y);
  }

  /** Reflects the drawing's current color and width. */
  update(drawing: Pick<InkDrawing, 'id' | 'color' | 'width'>): void {
    if (drawing.id !== this.currentId) return;
    this.color.setValue(drawing.color);
    this.widths.set(drawing.width);
  }

  hide(): void {
    this.element.hidden = true;
    this.currentId = undefined;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  get drawingId(): string | undefined {
    return this.element.hidden ? undefined : this.currentId;
  }
}

export interface TextPopoverActions {
  setStyle(id: string, patch: Partial<TextStyle>): void;
  /** The reader chose what the text box follows. */
  attach(id: string, to: Attachment): void;
  /** Opens (or closes) the color picker for the text color, under `anchor`. */
  pickColor(id: string, anchor: HTMLElement): void;
  edit(id: string): void;
  /** Copies it (it is the selection). */
  copy(id: string): void;
  remove(id: string): void;
}

/**
 * Shown when a text box is selected (outside text mode), in two rows: how it looks (color, size,
 * format, alignment), then what it follows, Edit and delete.
 */
export class TextPopover {
  readonly element: HTMLElement;
  readonly color: ColorButton;
  private currentId?: string;
  private readonly controls: TextStyleControls;
  private readonly attached: ReturnType<typeof attachMenu>;

  /** Shows what the text box follows. */
  setAttached(to: Attachment): void {
    this.attached.set(to);
  }

  constructor(actions: TextPopoverActions) {
    this.attached = attachMenu((to) => {
      if (this.currentId) actions.attach(this.currentId, to);
    });
    this.color = new ColorButton('Text color', (anchor) => {
      if (this.currentId) actions.pickColor(this.currentId, anchor);
    });
    this.controls = textStyleControls((patch) => {
      if (this.currentId) actions.setStyle(this.currentId, patch);
    });
    const edit = labelButton(icon('edit'), 'Edit', 'Edit the text (Enter, or double-click the box)');
    edit.addEventListener('click', () => {
      const id = this.currentId;
      this.hide();
      if (id) actions.edit(id);
    });
    const copy = iconButton('copy', `Copy text box (${MOD_KEY}+C)`);
    copy.addEventListener('click', () => {
      if (this.currentId) actions.copy(this.currentId);
    });
    const remove = iconButton('trash', 'Delete text box (Delete)', { class: 'mpv-btn mpv-btn-danger' });
    remove.addEventListener('click', () => {
      const id = this.currentId;
      this.hide();
      if (id) actions.remove(id);
    });
    this.element = h(
      'div',
      { class: 'mpv-popover mpv-drawing-popover mpv-text-popover', role: 'dialog', 'aria-label': 'Edit text box', hidden: true },
      h('div', { class: 'mpv-popover-row mpv-wraps' }, this.color.element, this.controls.size, this.controls.format, this.controls.align),
      h('div', { class: 'mpv-popover-row' }, this.attached.element, h('span', { class: 'mpv-grow' }), edit, copy, sep(), remove),
    );
    document.body.append(this.element);
  }

  show(text: TextDrawing, x: number, y: number): void {
    this.currentId = text.id;
    this.update(text);
    placeFloating(this.element, x, y);
  }

  update(text: TextDrawing): void {
    if (text.id !== this.currentId) return;
    this.controls.set(textStyleOf(text));
    this.color.setValue(text.color);
  }

  hide(): void {
    this.element.hidden = true;
    this.currentId = undefined;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  get textId(): string | undefined {
    return this.element.hidden ? undefined : this.currentId;
  }
}

/** The note of a highlight, shown while hovering it. */
export class NoteTooltip {
  readonly element = h('div', { class: 'mpv-tooltip mpv-note-tooltip', role: 'tooltip', hidden: true });
  private timer?: ReturnType<typeof setTimeout>;
  private currentId?: string;

  constructor() {
    document.body.append(this.element);
  }

  /** Shows the note after a short delay (or moves it, if it is already showing for this highlight). */
  schedule(id: string, note: string, x: number, y: number): void {
    if (this.currentId === id && !this.element.hidden) return;
    clearTimeout(this.timer);
    this.currentId = id;
    this.timer = setTimeout(() => {
      this.element.replaceChildren(h('div', { class: 'mpv-tooltip-title', text: 'Note' }), h('div', { class: 'mpv-tooltip-body', text: note }));
      placeFloating(this.element, x, y + 8);
    }, 300);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.currentId = undefined;
    this.element.hidden = true;
  }
}

/** Options for the reading marker (shown when clicking its tab): the marked line, Move and Remove. */
export class MarkerPopover {
  readonly element: HTMLElement;
  private readonly line = h('span', { class: 'mpv-marker-popover-line' });
  private readonly label = h('span', { class: 'mpv-marker-popover-label', text: 'You stopped at' });

  constructor(actions: { move(): void; remove(): void }) {
    const move = labelButton(icon('move'), 'Move', 'Move the reading marker: click this, then click a line');
    const remove = labelButton(icon('trash'), 'Remove', 'Remove the reading marker (Delete)', 'mpv-btn mpv-btn-label mpv-btn-danger');
    move.addEventListener('click', () => {
      this.hide();
      actions.move();
    });
    remove.addEventListener('click', () => {
      this.hide();
      actions.remove();
    });
    this.element = h(
      'div',
      { class: 'mpv-popover mpv-marker-popover', role: 'dialog', 'aria-label': 'Reading marker', hidden: true },
      h('div', { class: 'mpv-marker-popover-title' }, this.label, this.line),
      h('div', { class: 'mpv-popover-row' }, move, remove),
    );
    document.body.append(this.element);
  }

  /** `line`: the text of the marked line (or where it is, when there is no text); `when`: the day it was marked. */
  show(line: string, when: string, x: number, y: number): void {
    this.label.textContent = when ? `You stopped at · ${when}` : 'You stopped at';
    this.line.textContent = line;
    placeFloating(this.element, x, y);
  }

  hide(): void {
    this.element.hidden = true;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }
}

/** Shown next to a fresh selection (when no tool is on): the colors to highlight it in, a note, the reading marker. */
export class SelectionBar {
  readonly element: HTMLElement;
  private readonly swatches: Map<HighlightColor, HTMLButtonElement>;

  constructor(actions: { pick(color: HighlightColor): void; note(): void; marker(): void }) {
    this.swatches = highlightSwatches(
      (name) => `Highlight in ${name.toLowerCase()}`,
      (color) => actions.pick(color),
    );
    const note = iconButton('comment', 'Highlight and add a note');
    const marker = iconButton('bookmark', 'Mark this as where I stopped reading');
    // The selection stays while a button is pressed.
    for (const button of [...this.swatches.values(), note, marker]) button.addEventListener('pointerdown', (e) => e.preventDefault());
    note.addEventListener('click', () => actions.note());
    marker.addEventListener('click', () => actions.marker());
    const row = h('div', { class: 'mpv-popover-row' }, h('span', { class: 'mpv-popover-label mpv-label', text: 'Highlight' }), ...this.swatches.values(), sep(), note, marker);
    this.element = h('div', { class: 'mpv-popover mpv-selection-bar', hidden: true }, row);
    document.body.append(this.element);
  }

  /** The color a new highlight gets is ringed. */
  setColor(color: HighlightColor): void {
    markSwatch(this.swatches, color);
  }

  show(x: number, y: number): void {
    placeFloating(this.element, x, y);
  }

  hide(): void {
    this.element.hidden = true;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  get position(): [number, number] {
    const r = this.element.getBoundingClientRect();
    return [r.left + r.width / 2, r.top];
  }
}

export interface BannerAction {
  label: string;
  run(): void;
}

function linkButton(action: BannerAction, before?: () => void): HTMLButtonElement {
  const button = h('button', { class: 'mpv-link', type: 'button' }, h('span', { class: 'mpv-label', text: action.label }));
  button.addEventListener('click', () => {
    before?.();
    action.run();
  });
  return button;
}

/** A short message in a pill at the bottom of the pages, optionally with an action (e.g. "Undo"). */
export class Toast {
  readonly element = h('div', { class: 'mpv-toast', role: 'status', 'aria-live': 'polite', hidden: true });
  private timer?: ReturnType<typeof setTimeout>;

  /** `marker`: the message is about the reading marker (its bookmark comes first). */
  show(message: string, options: { action?: BannerAction; sticky?: boolean; durationMs?: number; marker?: boolean } = {}): void {
    clearTimeout(this.timer);
    this.element.replaceChildren(
      ...(options.marker ? [h('span', { class: 'codicon codicon-bookmark mpv-toast-icon', 'aria-hidden': 'true' })] : []),
      h('span', { class: 'mpv-toast-text', text: message }),
      ...(options.action ? [linkButton(options.action, () => this.hide())] : []),
    );
    this.element.classList.toggle('mpv-toast-action', options.action !== undefined);
    this.element.hidden = false;
    if (!options.sticky) this.timer = setTimeout(() => this.hide(), options.durationMs ?? 4000);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.element.hidden = true;
  }
}

/** A full-width strip under the bars: a warning, an error or a note, with actions as links and a way to dismiss it. */
export class Banner {
  readonly element: HTMLElement;
  private readonly text = h('div', { class: 'mpv-banner-text' });
  private readonly actionsBox = h('div', { class: 'mpv-banner-actions' });
  private readonly iconBox = h('span', { class: 'mpv-banner-icon' });

  constructor() {
    const close = iconButton('close', 'Dismiss', { class: 'mpv-btn mpv-btn-sm' });
    close.addEventListener('click', () => this.hide());
    this.element = h('div', { class: 'mpv-banner', role: 'status', hidden: true }, this.iconBox, this.text, this.actionsBox, close);
  }

  show(kind: 'warning' | 'error' | 'info', message: string, actions: BannerAction[] = []): void {
    this.element.dataset.kind = kind;
    this.iconBox.replaceChildren(icon(kind === 'info' ? 'info' : kind));
    this.text.textContent = message;
    this.text.title = message;
    this.actionsBox.replaceChildren(...actions.map((a) => linkButton(a)));
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }
}

/** Centered status shown before the first PDF arrives, when the first render failed, or for a password. */
export class StatusOverlay {
  readonly element: HTMLElement;
  private readonly box = h('div', { class: 'mpv-status-box' });

  constructor() {
    this.element = h('div', { class: 'mpv-status', hidden: true }, this.box);
  }

  /** First load: the wordmark, a spinner, and what is being opened. */
  loading(message: string): void {
    this.box.replaceChildren(
      h('div', { class: 'mpv-wordmark' }, bookIcon(20), h('span', { class: 'mpv-label', text: 'Reading Room' })),
      h('div', { class: 'mpv-spinner', 'aria-hidden': 'true' }),
      h('p', { class: 'mpv-status-detail', text: message }),
    );
    this.element.hidden = false;
  }

  error(title: string, message: string, actions: BannerAction[]): void {
    const buttons = h(
      'div',
      { class: 'mpv-status-actions' },
      ...actions.map((a, i) => {
        const b = filledButton(a.label, i === 0);
        b.addEventListener('click', () => a.run());
        return b;
      }),
    );
    this.box.replaceChildren(
      h('span', { class: 'codicon codicon-error mpv-status-icon mpv-error-icon' }),
      h('p', { class: 'mpv-status-title', text: title }),
      h('p', { class: 'mpv-status-detail', text: message }),
      buttons,
    );
    this.element.hidden = false;
  }

  /** Asks for the password of an encrypted PDF. Resolves with undefined when cancelled. */
  password(fileName: string, incorrect: boolean): Promise<string | undefined> {
    return new Promise((resolve) => {
      const input = h('input', { class: 'mpv-field mpv-password-input', type: 'password', 'aria-label': 'Password', autocomplete: 'off' });
      const open = filledButton('Open', true, 'submit');
      const cancel = filledButton('Cancel', false);
      const form = h(
        'form',
        { class: 'mpv-password-form' },
        h('span', { class: 'codicon codicon-lock mpv-status-icon' }),
        h('p', { class: 'mpv-status-title', text: `${fileName} is password-protected` }),
        h('p', {
          class: incorrect ? 'mpv-status-detail mpv-error-text' : 'mpv-status-detail',
          text: incorrect ? 'That password is not correct. Try again.' : 'Enter the password to open it.',
        }),
        input,
        h('div', { class: 'mpv-status-actions' }, open, cancel),
      );
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        resolve(input.value);
      });
      cancel.addEventListener('click', () => resolve(undefined));
      this.box.replaceChildren(form);
      this.element.hidden = false;
      setTimeout(() => input.focus(), 0);
    });
  }

  hide(): void {
    this.element.hidden = true;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }
}
