// The viewer toolbar:
// [☰] [↑] [n / N] [↓] | [−] [zoom ▾] [+] [↺] | [✎] [● ● ● ● ●] | [🔖 ▾] | [🎧] [◐] [⟳] [⤢] [⤓ ▾]
import type { SoundState } from '../src/shared/sounds';
import { HIGHLIGHT_COLORS, HIGHLIGHT_HEX, MAX_ZOOM, MIN_ZOOM, type DocumentKind, type HighlightColor, type PageTheme, type ZoomValue } from '../src/shared/types';
import { h, icon, iconButton, placeFloating } from './dom';
import { headphonesIcon } from './sounds';

export interface ToolbarActions {
  toggleList(): void;
  previousPage(): void;
  nextPage(): void;
  goToPage(page: number): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  setZoom(zoom: ZoomValue): void;
  toggleTool(): void;
  setColor(color: HighlightColor): void;
  placeMarker(): void;
  goToMarker(): void;
  removeMarker(): void;
  /** Opens or closes the reading sounds panel below `anchor`. */
  toggleSounds(anchor: HTMLElement): void;
  toggleTheme(): void;
  refresh(): void;
  toggleFullView(): void;
  download(withHighlights: boolean): void;
}

const ZOOM_OPTIONS: { value: string; label: string }[] = [
  { value: 'page-width', label: 'Fit Width' },
  { value: 'page-fit', label: 'Fit Page' },
  { value: 'page-actual', label: 'Actual Size' },
  ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((v) => ({ value: String(v), label: `${Math.round(v * 100)}%` })),
];

const COLOR_NAMES: Record<HighlightColor, string> = {
  yellow: 'Yellow',
  pink: 'Pink',
  green: 'Green',
  blue: 'Blue',
  orange: 'Orange',
};

interface MenuItem {
  icon: string;
  label: string;
  run(): void;
}

/** A drop-down menu opened from a small chevron button. */
class DropDown {
  readonly menu: HTMLElement;
  readonly toggle: HTMLButtonElement;
  private readonly items = new Map<string, HTMLButtonElement>();

  constructor(title: string, entries: (MenuItem & { key: string })[]) {
    this.toggle = iconButton('chevron-down', title, { class: 'mpv-btn mpv-btn-narrow' });
    this.menu = h('div', { class: 'mpv-menu', role: 'menu', hidden: true });
    for (const entry of entries) {
      const item = h('button', { class: 'mpv-menu-item', type: 'button', role: 'menuitem' }, icon(entry.icon), h('span', { text: entry.label }));
      item.addEventListener('click', () => {
        this.menu.hidden = true;
        entry.run();
      });
      this.items.set(entry.key, item);
      this.menu.append(item);
    }
    document.body.append(this.menu);
    this.toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.menu.hidden) {
        this.menu.hidden = true;
        return;
      }
      const r = this.toggle.getBoundingClientRect();
      placeFloating(this.menu, r.right - 110, r.bottom - 4);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.contains(e.target as Node) && !this.toggle.contains(e.target as Node)) this.menu.hidden = true;
    });
  }

  setEnabled(key: string, enabled: boolean): void {
    const item = this.items.get(key);
    if (item) item.disabled = !enabled;
  }
}

export class Toolbar {
  readonly element: HTMLElement;
  private readonly listButton = iconButton('list-flat', 'Highlights list');
  private readonly pageInput = h('input', { class: 'mpv-page-input', type: 'text', inputmode: 'numeric', 'aria-label': 'Page number', value: '1' });
  private readonly pageCount = h('span', { class: 'mpv-page-count', text: '/ 0' });
  private readonly zoomSelect = h('select', { class: 'mpv-zoom-select', title: 'Zoom', 'aria-label': 'Zoom' });
  private readonly customZoom = h('option', { value: 'custom', hidden: true });
  private readonly toolButton = iconButton('edit', 'Highlight tool: select text to highlight it');
  private readonly swatches = new Map<HighlightColor, HTMLButtonElement>();
  private readonly markerButton = iconButton('bookmark', 'Mark where you stopped reading: click this, then click a line');
  private readonly markerMenu: DropDown;
  private readonly soundsButton = h(
    'button',
    { class: 'mpv-btn mpv-sounds-button', type: 'button', title: 'Reading sounds', 'aria-label': 'Reading sounds', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', hidden: true },
    headphonesIcon(),
  );
  private readonly themeButton = iconButton('color-mode', 'Dark pages');
  private readonly refreshButton = iconButton('refresh', 'Refresh the PDF');
  private readonly fullButton = iconButton('screen-full', 'Full view');
  private readonly downloadMenu: DropDown;

  constructor(private readonly actions: ToolbarActions) {
    const prev = iconButton('arrow-up', 'Previous page');
    const next = iconButton('arrow-down', 'Next page');
    const zoomOut = iconButton('zoom-out', 'Zoom out (Ctrl+-)');
    const zoomIn = iconButton('zoom-in', 'Zoom in (Ctrl+=)');
    const zoomReset = iconButton('discard', 'Reset zoom to fit width (Ctrl+0)');
    const download = iconButton('download', 'Download PDF (with highlights and notes)');

    this.zoomSelect.append(this.customZoom, ...ZOOM_OPTIONS.map((o) => h('option', { value: o.value, text: o.label })));

    const colors = h('div', { class: 'mpv-swatches', role: 'radiogroup', 'aria-label': 'Highlight color' });
    for (const color of HIGHLIGHT_COLORS) {
      const swatch = h('button', {
        class: 'mpv-swatch',
        type: 'button',
        role: 'radio',
        title: `${COLOR_NAMES[color]} highlight`,
        'aria-label': COLOR_NAMES[color],
        'data-color': color,
      });
      swatch.style.setProperty('--swatch', HIGHLIGHT_HEX[color]);
      swatch.addEventListener('click', () => actions.setColor(color));
      this.swatches.set(color, swatch);
      colors.append(swatch);
    }

    this.markerMenu = new DropDown('Reading marker options', [
      { key: 'place', icon: 'bookmark', label: 'Mark where I stopped reading…', run: () => actions.placeMarker() },
      { key: 'goto', icon: 'arrow-right', label: 'Go to where I stopped reading', run: () => actions.goToMarker() },
      { key: 'remove', icon: 'close', label: 'Remove the reading marker', run: () => actions.removeMarker() },
    ]);
    this.downloadMenu = new DropDown('More download options', [
      { key: 'with', icon: 'download', label: 'Download PDF (with highlights and notes)', run: () => actions.download(true) },
      { key: 'without', icon: 'file-pdf', label: 'Download PDF without highlights', run: () => actions.download(false) },
    ]);
    this.setMarkerState(false, false);

    this.element = h(
      'header',
      { class: 'mpv-toolbar', role: 'toolbar', 'aria-label': 'Document viewer' },
      h('div', { class: 'mpv-group' }, this.listButton),
      h('div', { class: 'mpv-group' }, prev, h('div', { class: 'mpv-page' }, this.pageInput, this.pageCount), next),
      h('div', { class: 'mpv-group' }, zoomOut, this.zoomSelect, zoomIn, zoomReset),
      h('div', { class: 'mpv-group' }, this.toolButton, colors),
      h('div', { class: 'mpv-group' }, h('div', { class: 'mpv-split' }, this.markerButton, this.markerMenu.toggle)),
      h('div', { class: 'mpv-spacer' }),
      h(
        'div',
        { class: 'mpv-group' },
        this.soundsButton,
        this.themeButton,
        this.refreshButton,
        this.fullButton,
        h('div', { class: 'mpv-split' }, download, this.downloadMenu.toggle),
      ),
    );

    this.listButton.addEventListener('click', () => actions.toggleList());
    prev.addEventListener('click', () => actions.previousPage());
    next.addEventListener('click', () => actions.nextPage());
    zoomOut.addEventListener('click', () => actions.zoomOut());
    zoomIn.addEventListener('click', () => actions.zoomIn());
    zoomReset.addEventListener('click', () => actions.resetZoom());
    this.toolButton.addEventListener('click', () => actions.toggleTool());
    this.markerButton.addEventListener('click', () => actions.placeMarker());
    this.soundsButton.addEventListener('click', () => actions.toggleSounds(this.soundsButton));
    this.themeButton.addEventListener('click', () => actions.toggleTheme());
    this.refreshButton.addEventListener('click', () => actions.refresh());
    this.fullButton.addEventListener('click', () => actions.toggleFullView());
    download.addEventListener('click', () => actions.download(true));
    this.zoomSelect.addEventListener('change', () => {
      const value = this.zoomSelect.value;
      if (value === 'custom') return;
      actions.setZoom(value.startsWith('page-') ? (value as ZoomValue) : Number(value));
    });
    this.pageInput.addEventListener('change', () => {
      const n = parseInt(this.pageInput.value, 10);
      if (Number.isFinite(n)) actions.goToPage(n);
    });
    this.pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.pageInput.blur();
      }
    });
    this.pageInput.addEventListener('focus', () => this.pageInput.select());
  }

  /** Adapts the buttons to the kind of document: PDF files have no source to show next to. */
  setKind(kind: DocumentKind): void {
    this.fullButton.hidden = kind === 'pdf';
    this.refreshButton.title = kind === 'pdf' ? 'Reload the PDF from disk' : 'Convert the document again';
    this.refreshButton.setAttribute('aria-label', this.refreshButton.title);
  }

  setPage(page: number, count: number): void {
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(page);
    this.pageCount.textContent = `/ ${count}`;
    this.pageInput.size = Math.max(2, String(count).length);
  }

  setZoom(zoom: ZoomValue, scale: number): void {
    const value = String(zoom);
    const known = ZOOM_OPTIONS.find((o) => o.value === value);
    if (known) {
      this.customZoom.hidden = true;
      this.zoomSelect.value = value;
    } else {
      this.customZoom.hidden = false;
      this.customZoom.textContent = `${Math.round(scale * 100)}%`;
      this.zoomSelect.value = 'custom';
    }
    this.zoomSelect.title = `Zoom: ${Math.round(scale * 100)}% (${MIN_ZOOM * 100}–${MAX_ZOOM * 100}%)`;
  }

  setTool(active: boolean): void {
    this.toolButton.classList.toggle('mpv-active', active);
    this.toolButton.setAttribute('aria-pressed', String(active));
    this.toolButton.title = active ? 'Highlight tool is on: selecting text highlights it (click to turn off)' : 'Highlight tool: select text to highlight it';
  }

  setColor(color: HighlightColor): void {
    for (const [c, swatch] of this.swatches) {
      swatch.classList.toggle('mpv-selected', c === color);
      swatch.setAttribute('aria-checked', String(c === color));
    }
  }

  setMarkerState(exists: boolean, placing: boolean): void {
    this.markerButton.classList.toggle('mpv-active', placing);
    this.markerButton.classList.toggle('mpv-has-marker', exists);
    this.markerButton.setAttribute('aria-pressed', String(placing));
    this.markerButton.title = placing
      ? 'Click the line where you stopped reading (Esc cancels)'
      : exists
        ? 'Move the reading marker: click this, then click a line'
        : 'Mark where you stopped reading: click this, then click a line';
    this.markerButton.setAttribute('aria-label', this.markerButton.title);
    this.markerMenu.setEnabled('goto', exists);
    this.markerMenu.setEnabled('remove', exists);
  }

  /** The button only shows when this build has reading sounds. */
  setSoundsAvailable(available: boolean): void {
    this.soundsButton.hidden = !available;
  }

  /** The reading sounds panel hangs from this button. */
  get soundsAnchor(): HTMLElement | undefined {
    return this.soundsButton.hidden ? undefined : this.soundsButton;
  }

  setSoundState(state: SoundState, name: string): void {
    this.soundsButton.classList.toggle('mpv-playing', state.playing);
    this.soundsButton.title = state.playing ? `Reading sounds: "${name}" is playing` : 'Reading sounds';
    this.soundsButton.setAttribute('aria-label', this.soundsButton.title);
  }

  setSoundsOpen(open: boolean): void {
    this.soundsButton.classList.toggle('mpv-active', open);
    this.soundsButton.setAttribute('aria-expanded', String(open));
  }

  setTheme(theme: PageTheme): void {
    this.themeButton.classList.toggle('mpv-active', theme === 'dark');
    this.themeButton.setAttribute('aria-pressed', String(theme === 'dark'));
    this.themeButton.title = theme === 'dark' ? 'Dark pages are on (click for light pages)' : 'Dark pages (click to switch the PDF to a dark theme)';
  }

  setFullView(full: boolean): void {
    this.fullButton.replaceChildren(icon(full ? 'screen-normal' : 'screen-full'));
    this.fullButton.title = full ? 'Show the PDF next to the source file' : 'Full view: show the PDF in the source file’s editor group';
    this.fullButton.setAttribute('aria-label', this.fullButton.title);
  }

  setListOpen(open: boolean): void {
    this.listButton.classList.toggle('mpv-active', open);
    this.listButton.setAttribute('aria-pressed', String(open));
  }
}
