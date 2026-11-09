// Sidebar (highlights list), popovers, banner and status overlay.
import { HIGHLIGHT_COLORS, HIGHLIGHT_HEX, type Highlight, type HighlightColor } from '../src/shared/types';
import { h, icon, iconButton, placeFloating } from './dom';

export interface ListEntry {
  data: Highlight;
  page?: number;
}

export interface SidebarActions {
  reveal(id: string): void;
  remove(id: string): void;
  copy(text: string): void;
  close(): void;
}

function excerpt(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

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

  render(entries: ListEntry[]): void {
    const anchored = entries.filter((e) => e.data.status !== 'orphaned');
    const orphaned = entries.filter((e) => e.data.status === 'orphaned');
    this.title.textContent = `Highlights (${entries.length})`;
    const items: HTMLElement[] = [];
    if (entries.length === 0) {
      items.push(
        h(
          'div',
          { class: 'mpv-empty' },
          h('p', { text: 'No highlights yet.' }),
          h('p', { text: 'Turn on the highlight tool, or select text and pick a color.' }),
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
    }
    actions.append(remove);
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
      h('div', { class: 'mpv-item-body' }, h('div', { class: 'mpv-item-text', text: excerpt(quote) }), h('div', { class: 'mpv-item-meta', text: orphaned ? 'not found in the document' : entry.page !== undefined ? `page ${entry.page + 1}` : '' })),
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

/** Swatches + actions shown when clicking an existing highlight. */
export class HighlightPopover {
  readonly element: HTMLElement;
  private currentId?: string;
  private readonly swatches = new Map<HighlightColor, HTMLButtonElement>();

  constructor(actions: { setColor(id: string, color: HighlightColor): void; remove(id: string): void; copy(id: string): void }) {
    const row = h('div', { class: 'mpv-popover-row' });
    for (const color of HIGHLIGHT_COLORS) {
      const swatch = h('button', { class: 'mpv-swatch', type: 'button', title: `Change to ${color}`, 'aria-label': color, 'data-color': color });
      swatch.style.setProperty('--swatch', HIGHLIGHT_HEX[color]);
      swatch.addEventListener('click', () => {
        if (this.currentId) actions.setColor(this.currentId, color);
        this.hide();
      });
      this.swatches.set(color, swatch);
      row.append(swatch);
    }
    const copy = iconButton('copy', 'Copy text');
    copy.addEventListener('click', () => {
      if (this.currentId) actions.copy(this.currentId);
      this.hide();
    });
    const remove = iconButton('trash', 'Delete highlight');
    remove.addEventListener('click', () => {
      if (this.currentId) actions.remove(this.currentId);
      this.hide();
    });
    row.append(h('span', { class: 'mpv-popover-sep' }), copy, remove);
    this.element = h('div', { class: 'mpv-popover', role: 'dialog', 'aria-label': 'Edit highlight', hidden: true }, row);
    document.body.append(this.element);
  }

  show(id: string, color: HighlightColor, x: number, y: number): void {
    this.currentId = id;
    for (const [c, swatch] of this.swatches) swatch.classList.toggle('mpv-selected', c === color);
    placeFloating(this.element, x, y);
  }

  hide(): void {
    this.element.hidden = true;
    this.currentId = undefined;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }
}

/** Color dots shown next to a fresh selection (when the highlight tool is off). */
export class SelectionBar {
  readonly element: HTMLElement;

  constructor(onPick: (color: HighlightColor) => void) {
    const row = h('div', { class: 'mpv-popover-row' }, h('span', { class: 'mpv-popover-label', text: 'Highlight' }));
    for (const color of HIGHLIGHT_COLORS) {
      const swatch = h('button', { class: 'mpv-swatch', type: 'button', title: `Highlight in ${color}`, 'aria-label': `Highlight in ${color}` });
      swatch.style.setProperty('--swatch', HIGHLIGHT_HEX[color]);
      swatch.addEventListener('pointerdown', (e) => e.preventDefault());
      swatch.addEventListener('click', () => onPick(color));
      row.append(swatch);
    }
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
}

export interface BannerAction {
  label: string;
  run(): void;
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

/** Centered status shown before the first PDF arrives, or when the first render failed. */
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

  error(message: string, actions: BannerAction[]): void {
    const buttons = h(
      'div',
      { class: 'mpv-status-actions' },
      ...actions.map((a) => {
        const b = h('button', { class: 'mpv-button', type: 'button', text: a.label });
        b.addEventListener('click', () => a.run());
        return b;
      }),
    );
    this.box.replaceChildren(h('span', { class: 'codicon codicon-error mpv-status-icon mpv-error-icon' }), h('p', { class: 'mpv-status-title', text: 'The PDF could not be created' }), h('p', { class: 'mpv-status-detail', text: message }), buttons);
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }
}
