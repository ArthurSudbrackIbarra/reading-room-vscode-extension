// Sidebar (highlights list), popovers (highlight, note, reading marker), tooltips, toast, banner
// and the status overlay.
import { HIGHLIGHT_COLORS, HIGHLIGHT_HEX, MAX_NOTE_LENGTH, type Highlight, type HighlightColor, type ReadingMarker } from '../src/shared/types';
import { h, icon, iconButton, placeFloating } from './dom';

export interface ListEntry {
  data: Highlight;
  page?: number;
}

export interface MarkerEntry {
  marker: ReadingMarker;
  page: number;
}

export interface SidebarActions {
  reveal(id: string): void;
  remove(id: string): void;
  copy(text: string): void;
  editNote(id: string): void;
  goToMarker(): void;
  removeMarker(): void;
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
  private readonly title = h('span', { class: 'mpv-sidebar-title', text: 'Highlights' });

  constructor(private readonly actions: SidebarActions) {
    const close = iconButton('close', 'Close the list');
    close.addEventListener('click', () => actions.close());
    this.element = h('aside', { class: 'mpv-sidebar', 'aria-label': 'Highlights', hidden: true }, h('div', { class: 'mpv-sidebar-header' }, this.title, close), this.list);
  }

  set open(value: boolean) {
    this.element.hidden = !value;
    document.body.classList.toggle('mpv-sidebar-open', value);
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  render(entries: ListEntry[], marker: MarkerEntry | null): void {
    const anchored = entries.filter((e) => e.data.status !== 'orphaned');
    const orphaned = entries.filter((e) => e.data.status === 'orphaned');
    this.title.textContent = `Highlights (${entries.length})`;
    const items: HTMLElement[] = [];
    if (marker) items.push(this.markerItem(marker));
    if (entries.length === 0) {
      items.push(
        h(
          'div',
          { class: 'mpv-empty' },
          h('p', { text: 'No highlights yet.' }),
          h('p', { text: 'Turn on the highlight tool, or select text and pick a color. Click a highlight to add a note.' }),
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
    this.list.replaceChildren(...items);
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
