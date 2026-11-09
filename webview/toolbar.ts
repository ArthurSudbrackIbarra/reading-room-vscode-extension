// The viewer toolbar:
// [☰] [↑] [n / N] [↓] | [−] [zoom ▾] [+] [↺] | [✎] [● ● ● ● ●] | [◐] [⟳] [⤢] [⤓ ▾]
import { HIGHLIGHT_COLORS, HIGHLIGHT_HEX, MAX_ZOOM, MIN_ZOOM, type HighlightColor, type PageTheme, type ZoomValue } from '../src/shared/types';
import { h, icon, iconButton, placeFloating } from './dom';

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

export class Toolbar {
  readonly element: HTMLElement;
  private readonly listButton = iconButton('list-flat', 'Highlights list');
  private readonly pageInput = h('input', { class: 'mpv-page-input', type: 'text', inputmode: 'numeric', 'aria-label': 'Page number', value: '1' });
  private readonly pageCount = h('span', { class: 'mpv-page-count', text: '/ 0' });
  private readonly zoomSelect = h('select', { class: 'mpv-zoom-select', title: 'Zoom', 'aria-label': 'Zoom' });
  private readonly customZoom = h('option', { value: 'custom', hidden: true });
  private readonly toolButton = iconButton('edit', 'Highlight tool: select text to highlight it');
  private readonly swatches = new Map<HighlightColor, HTMLButtonElement>();
  private readonly themeButton = iconButton('color-mode', 'Dark pages');
  private readonly fullButton = iconButton('screen-full', 'Full view');
  private readonly downloadMenu: HTMLElement;
  private readonly downloadToggle = iconButton('chevron-down', 'More download options', { class: 'mpv-btn mpv-btn-narrow' });

  constructor(private readonly actions: ToolbarActions) {
    const prev = iconButton('arrow-up', 'Previous page');
    const next = iconButton('arrow-down', 'Next page');
    const zoomOut = iconButton('zoom-out', 'Zoom out (Ctrl+-)');
    const zoomIn = iconButton('zoom-in', 'Zoom in (Ctrl+=)');
    const zoomReset = iconButton('discard', 'Reset zoom to fit width (Ctrl+0)');
    const refresh = iconButton('refresh', 'Refresh the PDF');
    const download = iconButton('download', 'Download PDF (with highlights)');

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

    this.downloadMenu = h(
      'div',
      { class: 'mpv-menu', role: 'menu', hidden: true },
      this.menuItem('download', 'Download PDF (with highlights)', () => actions.download(true)),
      this.menuItem('file-pdf', 'Download PDF without highlights', () => actions.download(false)),
    );

    this.element = h(
      'header',
      { class: 'mpv-toolbar', role: 'toolbar', 'aria-label': 'PDF viewer' },
      h('div', { class: 'mpv-group' }, this.listButton),
      h('div', { class: 'mpv-group' }, prev, h('div', { class: 'mpv-page' }, this.pageInput, this.pageCount), next),
      h('div', { class: 'mpv-group' }, zoomOut, this.zoomSelect, zoomIn, zoomReset),
      h('div', { class: 'mpv-group' }, this.toolButton, colors),
      h('div', { class: 'mpv-spacer' }),
      h('div', { class: 'mpv-group' }, this.themeButton, refresh, this.fullButton, h('div', { class: 'mpv-split' }, download, this.downloadToggle)),
    );
    document.body.append(this.downloadMenu);

    this.listButton.addEventListener('click', () => actions.toggleList());
    prev.addEventListener('click', () => actions.previousPage());
    next.addEventListener('click', () => actions.nextPage());
    zoomOut.addEventListener('click', () => actions.zoomOut());
    zoomIn.addEventListener('click', () => actions.zoomIn());
    zoomReset.addEventListener('click', () => actions.resetZoom());
    this.toolButton.addEventListener('click', () => actions.toggleTool());
    this.themeButton.addEventListener('click', () => actions.toggleTheme());
    refresh.addEventListener('click', () => actions.refresh());
    this.fullButton.addEventListener('click', () => actions.toggleFullView());
    download.addEventListener('click', () => actions.download(true));
    this.downloadToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.downloadMenu.hidden) {
        this.downloadMenu.hidden = true;
        return;
      }
      const r = this.downloadToggle.getBoundingClientRect();
      placeFloating(this.downloadMenu, r.right - 110, r.bottom - 4);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.downloadMenu.contains(e.target as Node) && e.target !== this.downloadToggle) this.downloadMenu.hidden = true;
    });
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

  private menuItem(iconName: string, label: string, run: () => void): HTMLButtonElement {
    const item = h('button', { class: 'mpv-menu-item', type: 'button', role: 'menuitem' }, icon(iconName), h('span', { text: label }));
    item.addEventListener('click', () => {
      this.downloadMenu.hidden = true;
      run();
    });
    return item;
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

  setTheme(theme: PageTheme): void {
    this.themeButton.classList.toggle('mpv-active', theme === 'dark');
    this.themeButton.setAttribute('aria-pressed', String(theme === 'dark'));
    this.themeButton.title = theme === 'dark' ? 'Dark pages are on (click for light pages)' : 'Dark pages (click to switch the PDF to a dark theme)';
  }

  setFullView(full: boolean): void {
    this.fullButton.replaceChildren(icon(full ? 'screen-normal' : 'screen-full'));
    this.fullButton.title = full ? 'Show the PDF next to the Markdown' : 'Full view: show the PDF in the Markdown editor group';
    this.fullButton.setAttribute('aria-label', this.fullButton.title);
  }

  setListOpen(open: boolean): void {
    this.listButton.classList.toggle('mpv-active', open);
    this.listButton.setAttribute('aria-pressed', String(open));
  }
}
