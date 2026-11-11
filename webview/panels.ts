// Sidebar (the annotations list), popovers (highlight, note, drawing, reading marker), tooltips,
// toast, banner and the status overlay.
import { TOOL_NAMES, type InkDrawing, type InkWidth, type TextDrawing, type TextStyle } from '../src/shared/drawings';
import { HIGHLIGHT_COLORS, HIGHLIGHT_HEX, MAX_NOTE_LENGTH, type Highlight, type HighlightColor, type ReadingMarker } from '../src/shared/types';
import { ColorButton } from './colorPicker';
import { h, icon, iconButton, placeFloating } from './dom';
import { textStyleControls, widthRadios, type TextStyleControls } from './drawingBar';
import { setInk } from './drawings';
import { textIcon } from './icons';

export interface ListEntry {
  data: Highlight;
  page?: number;
}

export interface MarkerEntry {
  marker: ReadingMarker;
  page: number;
}

export interface DrawingEntry {
  data: InkDrawing;
  /** False when its page is not in the document now (it is kept, but not shown). */
  onPage: boolean;
  thumbnail: SVGSVGElement;
}

export interface TextEntry {
  data: TextDrawing;
  onPage: boolean;
}

export interface SidebarActions {
  reveal(id: string): void;
  remove(id: string): void;
  copy(text: string): void;
  editNote(id: string): void;
  goToMarker(): void;
  removeMarker(): void;
  /** Drawings and text boxes. */
  revealDrawing(id: string): void;
  removeDrawing(id: string): void;
  removeAllDrawings(): void;
  removeAllTextBoxes(): void;
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

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD_KEY = isMac ? '⌘' : 'Ctrl';

export class Sidebar {
  readonly element: HTMLElement;
  private readonly list = h('div', { class: 'mpv-list', role: 'list' });
  private readonly title = h('span', { class: 'mpv-sidebar-title', text: 'Annotations' });

  constructor(private readonly actions: SidebarActions) {
    const close = iconButton('close', 'Close the list');
    close.addEventListener('click', () => actions.close());
    this.element = h('aside', { class: 'mpv-sidebar', 'aria-label': 'Annotations', hidden: true }, h('div', { class: 'mpv-sidebar-header' }, this.title, close), this.list);
  }

  set open(value: boolean) {
    this.element.hidden = !value;
    document.body.classList.toggle('mpv-sidebar-open', value);
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  render(entries: ListEntry[], marker: MarkerEntry | null, drawings: DrawingEntry[], texts: TextEntry[]): void {
    const anchored = entries.filter((e) => e.data.status !== 'orphaned');
    const orphaned = entries.filter((e) => e.data.status === 'orphaned');
    this.title.textContent = `Annotations (${entries.length + drawings.length + texts.length})`;
    const items: HTMLElement[] = [];
    if (marker) items.push(this.markerItem(marker));
    if (entries.length === 0 && drawings.length === 0 && texts.length === 0) {
      items.push(
        h(
          'div',
          { class: 'mpv-empty' },
          h('p', { text: 'No annotations yet.' }),
          h('p', {
            text: 'Turn on the highlight tool, or select text and pick a color. Click a highlight to add a note. Use Draw to draw on the page, and Text to type on it.',
          }),
        ),
      );
    }
    for (const entry of anchored) items.push(this.item(entry, false));
    if (orphaned.length > 0) {
      items.push(
        h(
          'div',
          { class: 'mpv-list-group', title: 'The text of these highlights is no longer in the document. They are kept until you delete them.' },
          icon('warning'),
          h('span', { text: `Orphaned (${orphaned.length})` }),
        ),
      );
      for (const entry of orphaned) items.push(this.item(entry, true));
    }
    if (drawings.length > 0) {
      const removeAll = iconButton('trash', 'Delete all drawings…', { class: 'mpv-btn mpv-item-action' });
      removeAll.addEventListener('click', () => this.actions.removeAllDrawings());
      items.push(h('div', { class: 'mpv-list-group mpv-drawings-group' }, h('span', { text: `Drawings (${drawings.length})` }), removeAll));
      for (const entry of drawings) items.push(this.drawingItem(entry));
    }
    if (texts.length > 0) {
      const removeAll = iconButton('trash', 'Delete all text boxes…', { class: 'mpv-btn mpv-item-action' });
      removeAll.addEventListener('click', () => this.actions.removeAllTextBoxes());
      items.push(h('div', { class: 'mpv-list-group mpv-drawings-group' }, h('span', { text: `Text boxes (${texts.length})` }), removeAll));
      for (const entry of texts) items.push(this.textItem(entry));
    }
    this.list.replaceChildren(...items);
  }

  private textItem(entry: TextEntry): HTMLElement {
    const { data } = entry;
    const remove = iconButton('trash', 'Delete text box', { class: 'mpv-btn mpv-item-action' });
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this.actions.removeDrawing(data.id);
    });
    const thumb = h('span', { class: 'mpv-thumb mpv-text-thumb' }, textIcon());
    setInk(thumb, data.color);
    const meta = entry.onPage ? `page ${data.pageIndex + 1}` : `page ${data.pageIndex + 1}, which the document no longer has`;
    const row = h(
      'div',
      {
        class: `mpv-item mpv-drawing-item${entry.onPage ? '' : ' mpv-orphan'}`,
        role: 'listitem',
        tabindex: entry.onPage ? 0 : undefined,
        title: entry.onPage ? 'Go to text box' : 'Not shown: its page is not in the document now. It is kept until you delete it.',
        'data-id': data.id,
      },
      thumb,
      h('div', { class: 'mpv-item-body' }, h('div', { class: 'mpv-item-text', text: excerpt(data.text, 90) }), h('div', { class: 'mpv-item-meta', text: meta })),
      h('div', { class: 'mpv-item-actions' }, remove),
    );
    if (entry.onPage) {
      row.addEventListener('click', () => this.actions.revealDrawing(data.id));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.actions.revealDrawing(data.id);
        }
      });
    }
    return row;
  }

  private drawingItem(entry: DrawingEntry): HTMLElement {
    const { data } = entry;
    const remove = iconButton('trash', 'Delete drawing', { class: 'mpv-btn mpv-item-action' });
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this.actions.removeDrawing(data.id);
    });
    const thumb = h('span', { class: 'mpv-thumb' }, entry.thumbnail);
    const meta = entry.onPage ? `page ${data.pageIndex + 1}` : `page ${data.pageIndex + 1}, which the document no longer has`;
    const row = h(
      'div',
      {
        class: `mpv-item mpv-drawing-item${entry.onPage ? '' : ' mpv-orphan'}`,
        role: 'listitem',
        tabindex: entry.onPage ? 0 : undefined,
        title: entry.onPage ? 'Go to drawing' : 'Not shown: its page is not in the document now. It is kept until you delete it.',
        'data-id': data.id,
      },
      thumb,
      h('div', { class: 'mpv-item-body' }, h('div', { class: 'mpv-item-text' }, h('span', { text: TOOL_NAMES[data.tool] }), h('span', { class: 'mpv-item-meta-inline', text: ` · ${meta}` }))),
      h('div', { class: 'mpv-item-actions' }, remove),
    );
    if (entry.onPage) {
      row.addEventListener('click', () => this.actions.revealDrawing(data.id));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.actions.revealDrawing(data.id);
        }
      });
    }
    return row;
  }

  private markerItem(entry: MarkerEntry): HTMLElement {
    const remove = iconButton('close', 'Remove the reading marker', { class: 'mpv-btn mpv-item-action' });
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this.actions.removeMarker();
    });
    const date = formatDate(entry.marker.createdAt);
    const quote = entry.marker.selector?.[0].exact;
    const row = h(
      'div',
      { class: 'mpv-item mpv-marker-item', role: 'listitem', tabindex: 0, title: 'Go to where you stopped reading' },
      h('span', { class: 'mpv-marker-dot' }, icon('bookmark')),
      h(
        'div',
        { class: 'mpv-item-body' },
        h('div', { class: 'mpv-item-text', text: 'Where you stopped reading' }),
        quote ? h('div', { class: 'mpv-item-quote', text: `“${excerpt(quote, 80)}”` }) : undefined,
        h('div', { class: 'mpv-item-meta', text: [`page ${entry.page + 1}`, date].filter(Boolean).join(' · ') }),
      ),
      h('div', { class: 'mpv-item-actions' }, remove),
    );
    row.addEventListener('click', () => this.actions.goToMarker());
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.actions.goToMarker();
      }
    });
    return row;
  }

  private item(entry: ListEntry, orphaned: boolean): HTMLElement {
    const quote = entry.data.target.selector[0].exact;
    const dot = h('span', { class: 'mpv-dot' });
    dot.style.setProperty('--swatch', HIGHLIGHT_HEX[entry.data.color]);
    const remove = iconButton('trash', 'Delete highlight', { class: 'mpv-btn mpv-item-action' });
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this.actions.remove(entry.data.id);
    });
    const actions = h('div', { class: 'mpv-item-actions' });
    if (orphaned) {
      const copy = iconButton('copy', 'Copy the highlighted text', { class: 'mpv-btn mpv-item-action' });
      copy.addEventListener('click', (e) => {
        e.stopPropagation();
        this.actions.copy(quote);
      });
      actions.append(copy);
    } else {
      const note = iconButton('comment', entry.data.note ? 'Edit the note' : 'Add a note', { class: 'mpv-btn mpv-item-action' });
      note.addEventListener('click', (e) => {
        e.stopPropagation();
        this.actions.editNote(entry.data.id);
      });
      actions.append(note);
    }
    actions.append(remove);
    const meta = orphaned ? 'not found in the document' : entry.page !== undefined ? `page ${entry.page + 1}` : '';
    const row = h(
      'div',
      {
        class: `mpv-item${orphaned ? ' mpv-orphan' : ''}`,
        role: 'listitem',
        tabindex: orphaned ? undefined : 0,
        title: orphaned ? 'Orphaned: this text is no longer in the document' : 'Go to highlight',
        'data-id': entry.data.id,
      },
      dot,
      h(
        'div',
        { class: 'mpv-item-body' },
        h('div', { class: 'mpv-item-text', text: excerpt(quote) }),
        entry.data.note ? h('div', { class: 'mpv-item-note' }, icon('comment'), h('span', { text: excerpt(entry.data.note, 220) })) : undefined,
        h('div', { class: 'mpv-item-meta', text: meta }),
      ),
      actions,
    );
    if (!orphaned) {
      row.addEventListener('click', () => this.actions.reveal(entry.data.id));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.actions.reveal(entry.data.id);
        }
      });
    }
    return row;
  }
}

export interface PopoverActions {
  setColor(id: string, color: HighlightColor): void;
  remove(id: string): void;
  copy(id: string): void;
  saveNote(id: string, note: string): void;
}

/** Shown when clicking a highlight: colors, note, copy, delete. The note can be edited in place. */
export class HighlightPopover {
  readonly element: HTMLElement;
  private currentId?: string;
  private note = '';
  private anchor: [number, number] = [0, 0];
  private readonly swatches = new Map<HighlightColor, HTMLButtonElement>();
  private readonly noteButton = iconButton('comment', 'Add a note');
  private readonly noteView = h('div', { class: 'mpv-note-view', role: 'button', tabindex: 0, title: 'Click to edit the note', hidden: true });
  private readonly textarea = h('textarea', {
    class: 'mpv-note-input',
    rows: 4,
    maxlength: MAX_NOTE_LENGTH,
    placeholder: 'Why is this highlighted? Write a note…',
    'aria-label': 'Note',
  });
  private readonly editor: HTMLElement;

  constructor(private readonly actions: PopoverActions) {
    const row = h('div', { class: 'mpv-popover-row' });
    for (const color of HIGHLIGHT_COLORS) {
      const swatch = h('button', { class: 'mpv-swatch', type: 'button', title: `Change to ${color}`, 'aria-label': color, 'data-color': color });
      swatch.style.setProperty('--swatch', HIGHLIGHT_HEX[color]);
      swatch.addEventListener('click', () => {
        if (this.currentId) actions.setColor(this.currentId, color);
        for (const [c, s] of this.swatches) s.classList.toggle('mpv-selected', c === color);
        if (!this.editing) this.hide();
      });
      this.swatches.set(color, swatch);
      row.append(swatch);
    }
    this.noteButton.addEventListener('click', () => this.startEditing());
    const copy = iconButton('copy', 'Copy text');
    copy.addEventListener('click', () => {
      if (this.currentId) actions.copy(this.currentId);
      this.hide();
    });
    const remove = iconButton('trash', 'Delete highlight');
    remove.addEventListener('click', () => {
      const id = this.currentId;
      this.hide(false);
      if (id) actions.remove(id);
    });
    row.append(h('span', { class: 'mpv-popover-sep' }), this.noteButton, copy, remove);

    this.noteView.addEventListener('click', () => this.startEditing());
    this.noteView.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.startEditing();
      }
    });

    const save = h('button', { class: 'mpv-button mpv-button-small', type: 'button', text: 'Save' });
    const cancel = h('button', { class: 'mpv-button mpv-button-small mpv-button-secondary', type: 'button', text: 'Cancel' });
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
      this.textarea,
      h('div', { class: 'mpv-note-editor-footer' }, h('span', { class: 'mpv-hint', text: `${MOD_KEY}+Enter to save` }), cancel, save),
    );
    this.element = h('div', { class: 'mpv-popover mpv-hl-popover', role: 'dialog', 'aria-label': 'Edit highlight', hidden: true }, row, this.noteView, this.editor);
    document.body.append(this.element);
  }

  show(id: string, data: { color: HighlightColor; note?: string }, x: number, y: number, options: { editNote?: boolean } = {}): void {
    this.currentId = id;
    this.note = data.note ?? '';
    this.anchor = [x, y];
    for (const [c, swatch] of this.swatches) swatch.classList.toggle('mpv-selected', c === data.color);
    this.noteButton.title = this.note ? 'Edit the note' : 'Add a note';
    this.noteButton.setAttribute('aria-label', this.noteButton.title);
    this.noteView.textContent = this.note;
    this.noteView.hidden = !this.note;
    this.editor.hidden = true;
    this.element.classList.remove('mpv-editing');
    placeFloating(this.element, x, y);
    if (options.editNote) this.startEditing();
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
  }
}

export interface DrawingPopoverActions {
  /** Opens (or closes) the color picker for the drawing's ink, under `anchor`. */
  pickColor(id: string, anchor: HTMLElement): void;
  setWidth(id: string, width: InkWidth): void;
  remove(id: string): void;
}

/** Shown when a drawing is selected: its ink, its width, delete. It stays open while changing them. */
export class DrawingPopover {
  readonly element: HTMLElement;
  readonly color: ColorButton;
  private currentId?: string;
  private readonly widths: ReturnType<typeof widthRadios>;

  constructor(actions: DrawingPopoverActions) {
    this.color = new ColorButton('Ink color', (anchor) => {
      if (this.currentId) actions.pickColor(this.currentId, anchor);
    });
    this.widths = widthRadios((width) => {
      if (this.currentId) actions.setWidth(this.currentId, width);
    });
    const remove = iconButton('trash', 'Delete drawing (Delete)');
    remove.addEventListener('click', () => {
      const id = this.currentId;
      this.hide();
      if (id) actions.remove(id);
    });
    const row = h('div', { class: 'mpv-popover-row' }, this.color.element, h('span', { class: 'mpv-popover-sep' }), this.widths.group, h('span', { class: 'mpv-popover-sep' }), remove);
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
  /** Opens (or closes) the color picker for the text color, under `anchor`. */
  pickColor(id: string, anchor: HTMLElement): void;
  edit(id: string): void;
  remove(id: string): void;
}

/** Shown when a text box is selected (outside text mode): its color, size, format, alignment, edit and delete. */
export class TextPopover {
  readonly element: HTMLElement;
  readonly color: ColorButton;
  private currentId?: string;
  private readonly controls: TextStyleControls;

  constructor(actions: TextPopoverActions) {
    this.color = new ColorButton('Text color', (anchor) => {
      if (this.currentId) actions.pickColor(this.currentId, anchor);
    });
    this.controls = textStyleControls((patch) => {
      if (this.currentId) actions.setStyle(this.currentId, patch);
    });
    const edit = iconButton('edit', 'Edit the text (Enter, or double-click the box)');
    edit.addEventListener('click', () => {
      const id = this.currentId;
      this.hide();
      if (id) actions.edit(id);
    });
    const remove = iconButton('trash', 'Delete text box (Delete)');
    remove.addEventListener('click', () => {
      const id = this.currentId;
      this.hide();
      if (id) actions.remove(id);
    });
    const sep = () => h('span', { class: 'mpv-popover-sep' });
    const row = h(
      'div',
      { class: 'mpv-popover-row' },
      this.color.element,
      sep(),
      this.controls.size,
      sep(),
      this.controls.format,
      sep(),
      this.controls.align,
      sep(),
      edit,
      remove,
    );
    this.element = h('div', { class: 'mpv-popover mpv-drawing-popover mpv-text-popover', role: 'dialog', 'aria-label': 'Edit text box', hidden: true }, row);
    document.body.append(this.element);
  }

  show(text: TextDrawing, x: number, y: number): void {
    this.currentId = text.id;
    this.update(text);
    placeFloating(this.element, x, y);
  }

  update(text: TextDrawing): void {
    if (text.id !== this.currentId) return;
    this.controls.set(text);
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
      this.element.replaceChildren(h('div', { class: 'mpv-tooltip-title' }, icon('comment'), h('span', { text: 'Note' })), h('div', { class: 'mpv-tooltip-body', text: note }));
      placeFloating(this.element, x, y + 8);
    }, 300);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.currentId = undefined;
    this.element.hidden = true;
  }
}

/** Options for the reading marker (shown when clicking its tab). */
export class MarkerPopover {
  readonly element: HTMLElement;
  private readonly title = h('div', { class: 'mpv-marker-popover-title' });

  constructor(actions: { move(): void; remove(): void }) {
    const move = h('button', { class: 'mpv-button mpv-button-small mpv-button-secondary', type: 'button' }, icon('move'), h('span', { text: 'Move' }));
    const remove = h('button', { class: 'mpv-button mpv-button-small mpv-button-secondary', type: 'button' }, icon('trash'), h('span', { text: 'Remove' }));
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
      this.title,
      h('div', { class: 'mpv-marker-popover-actions' }, move, remove),
    );
    document.body.append(this.element);
  }

  show(text: string, x: number, y: number): void {
    this.title.textContent = text;
    placeFloating(this.element, x, y);
  }

  hide(): void {
    this.element.hidden = true;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }
}

/** Color dots shown next to a fresh selection (when the highlight tool is off). */
export class SelectionBar {
  readonly element: HTMLElement;

  constructor(actions: { pick(color: HighlightColor): void; note(): void; marker(): void }) {
    const row = h('div', { class: 'mpv-popover-row' }, h('span', { class: 'mpv-popover-label', text: 'Highlight' }));
    for (const color of HIGHLIGHT_COLORS) {
      const swatch = h('button', { class: 'mpv-swatch', type: 'button', title: `Highlight in ${color}`, 'aria-label': `Highlight in ${color}` });
      swatch.style.setProperty('--swatch', HIGHLIGHT_HEX[color]);
      swatch.addEventListener('pointerdown', (e) => e.preventDefault());
      swatch.addEventListener('click', () => actions.pick(color));
      row.append(swatch);
    }
    const note = iconButton('comment', 'Highlight and add a note');
    const marker = iconButton('bookmark', 'Mark this as where I stopped reading');
    for (const button of [note, marker]) button.addEventListener('pointerdown', (e) => e.preventDefault());
    note.addEventListener('click', () => actions.note());
    marker.addEventListener('click', () => actions.marker());
    row.append(h('span', { class: 'mpv-popover-sep' }), note, marker);
    this.element = h('div', { class: 'mpv-popover mpv-selection-bar', hidden: true }, row);
    document.body.append(this.element);
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

/** A short message at the bottom of the viewer, optionally with an action (e.g. "Undo"). */
export class Toast {
  readonly element = h('div', { class: 'mpv-toast', role: 'status', 'aria-live': 'polite', hidden: true });
  private timer?: ReturnType<typeof setTimeout>;

  show(message: string, options: { action?: BannerAction; sticky?: boolean; durationMs?: number } = {}): void {
    clearTimeout(this.timer);
    const children: (Node | string)[] = [h('span', { class: 'mpv-toast-text', text: message })];
    if (options.action) {
      const { action } = options;
      const button = h('button', { class: 'mpv-link-button', type: 'button', text: action.label });
      button.addEventListener('click', () => {
        this.hide();
        action.run();
      });
      children.push(button);
    }
    this.element.replaceChildren(...children);
    this.element.hidden = false;
    this.element.classList.remove('mpv-toast-out');
    if (!options.sticky) this.timer = setTimeout(() => this.hide(), options.durationMs ?? 4000);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.element.hidden = true;
  }
}

export class Banner {
  readonly element: HTMLElement;
  private readonly text = h('div', { class: 'mpv-banner-text' });
  private readonly actionsBox = h('div', { class: 'mpv-banner-actions' });
  private readonly iconBox = h('span', { class: 'mpv-banner-icon' });

  constructor() {
    const close = iconButton('close', 'Dismiss');
    close.addEventListener('click', () => this.hide());
    this.element = h('div', { class: 'mpv-banner', role: 'status', hidden: true }, this.iconBox, this.text, this.actionsBox, close);
  }

  show(kind: 'warning' | 'error' | 'info', message: string, actions: BannerAction[] = []): void {
    this.element.dataset.kind = kind;
    this.iconBox.replaceChildren(icon(kind === 'info' ? 'info' : kind));
    this.text.textContent = message;
    this.text.title = message;
    this.actionsBox.replaceChildren(
      ...actions.map((a) => {
        const b = h('button', { class: 'mpv-link-button', type: 'button', text: a.label });
        b.addEventListener('click', () => a.run());
        return b;
      }),
    );
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

  loading(message: string): void {
    this.box.replaceChildren(h('span', { class: 'codicon codicon-loading codicon-modifier-spin mpv-status-icon' }), h('p', { text: message }));
    this.element.hidden = false;
  }

  error(title: string, message: string, actions: BannerAction[]): void {
    const buttons = h(
      'div',
      { class: 'mpv-status-actions' },
      ...actions.map((a) => {
        const b = h('button', { class: 'mpv-button', type: 'button', text: a.label });
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
      const input = h('input', { class: 'mpv-password-input', type: 'password', 'aria-label': 'Password', autocomplete: 'off' });
      const open = h('button', { class: 'mpv-button', type: 'submit', text: 'Open' });
      const cancel = h('button', { class: 'mpv-button mpv-button-secondary', type: 'button', text: 'Cancel' });
      const form = h(
        'form',
        { class: 'mpv-password-form' },
        h('span', { class: 'codicon codicon-lock mpv-status-icon' }),
        h('p', { class: 'mpv-status-title', text: `${fileName} is password-protected` }),
        h('p', { class: incorrect ? 'mpv-status-detail mpv-error-text' : 'mpv-status-detail', text: incorrect ? 'That password is not correct. Try again.' : 'Enter the password to open it.' }),
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
