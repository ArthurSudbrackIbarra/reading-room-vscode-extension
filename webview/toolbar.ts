// The viewer toolbar: one row in three zones, with flexible space between them.
//   find your place:  [☰] [↑ n / N ↓] [− zoom ▾ +]
//   annotate:         [select │ highlight │ draw │ text] [🔖 ▾] [↶]
//   the room:         [🎧] [◐] [⤓ ▾] [⋯]
// The four tools sit in one well: at most one is on, and the one that is on gets a tinted, ringed
// chip; its options are in its tray (the row under the toolbar). The three tools that make
// something show their color in a band under their icon.
// The toolbar never wraps. As the viewer gets narrower, controls move into the More menu, which
// always lists exactly what is not on the bar (see `layout`).
import type { Ink } from '../src/shared/colors';
import type { SoundState } from '../src/shared/sounds';
import { HIGHLIGHT_HEX, MAX_ZOOM, MIN_ZOOM, type DocumentKind, type HighlightColor, type PageTheme, type ZoomValue } from '../src/shared/types';
import { narrower, sizeClassOf, type SizeClass } from '../src/shared/ui';
import { h, iconButton, MOD_KEY, placeUnder } from './dom';
import { setInk } from './drawings';
import { chevronIcon, drawIcon, highlighterIcon, pageIcon, selectIcon, textIcon } from './icons';
import { byKeyboard, menu, type MenuPart } from './menu';
import { headphonesIcon } from './sounds';

export interface ToolbarActions {
  toggleList(): void;
  previousPage(): void;
  nextPage(): void;
  goToPage(page: number): void;
  zoomIn(): void;
  zoomOut(): void;
  setZoom(zoom: ZoomValue): void;
  toggleTool(): void;
  toggleDrawing(): void;
  toggleText(): void;
  toggleSelect(): void;
  /** Takes back the last change (or, while typing, the last typing). */
  undo(): void;
  placeMarker(): void;
  goToMarker(): void;
  removeMarker(): void;
  /** Opens or closes the reading sounds panel below `anchor`. */
  toggleSounds(anchor: HTMLElement): void;
  toggleTheme(): void;
  refresh(): void;
  toggleFullView(): void;
  /** `withAnnotations`: with highlights, notes, drawings and text boxes (the default), or without any. */
  download(withAnnotations: boolean): void;
}

const HIGHLIGHT_TITLE = 'Highlight text: select text to highlight it';
const HIGHLIGHT_ON_TITLE = 'Highlighting is on: selecting text highlights it (Esc to stop)';
const DRAW_TITLE = 'Draw on the page: pen, lines, arrows, rectangles, ellipses';
const DRAW_ON_TITLE = 'Drawing is on (Esc to stop)';
const TEXT_TITLE = 'Add text: click on the page and type';
const TEXT_ON_TITLE = 'Adding text is on (Esc to stop)';
const SELECT_TITLE = 'Select: click a highlight, drawing or text box, or drag around several, to move, copy or delete them';
const DARK_TITLE = 'Dark pages';
const DARK_ON_TITLE = 'Dark pages are on: click for light pages';
const SELECT_ON_TITLE = 'Selecting is on (Esc to stop)';
const DOWNLOAD_TITLE = 'Download PDF with annotations';

const ZOOM_FITS: { value: ZoomValue; label: string; icon: string }[] = [
  { value: 'page-width', label: 'Fit width', icon: 'arrow-both' },
  { value: 'page-fit', label: 'Fit page', icon: 'file' },
  { value: 'page-actual', label: 'Actual size', icon: 'screen-normal' },
];
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function toolButton(className: string, title: string, glyph: SVGSVGElement): HTMLButtonElement {
  return h('button', { class: `mpv-btn ${className}`, type: 'button', title, 'aria-label': title, 'aria-pressed': 'false' }, glyph);
}

/** The ▾ half of a split button. */
function menuToggle(title: string): HTMLButtonElement {
  return h('button', { class: 'mpv-btn', type: 'button', title, 'aria-label': title, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, chevronIcon());
}

export class Toolbar {
  readonly element: HTMLElement;
  private readonly listButton = iconButton('list-flat', 'Annotations list: highlights, notes, drawings and text boxes', { 'aria-pressed': 'false' });
  private readonly prevButton = iconButton('arrow-up', 'Previous page');
  private readonly nextButton = iconButton('arrow-down', 'Next page');
  private readonly pageInput = h('input', { class: 'mpv-page-input', type: 'text', inputmode: 'numeric', 'aria-label': 'Page number', value: '1' });
  private readonly pageCount = h('span', { class: 'mpv-page-count', text: '/ 0' });
  private readonly pageStep: HTMLElement;
  private readonly zoomLabel = h('span', { class: 'mpv-label' });
  private readonly zoomButton = h('button', { class: 'mpv-step-value', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, this.zoomLabel, chevronIcon());
  private readonly zoomStep: HTMLElement;
  private readonly highlightButton = toolButton('mpv-highlight-tool', HIGHLIGHT_TITLE, highlighterIcon());
  private readonly drawButton = toolButton('mpv-draw-button', DRAW_TITLE, drawIcon());
  private readonly textButton = toolButton('mpv-text-button', TEXT_TITLE, textIcon());
  private readonly selectButton = toolButton('mpv-select-button', SELECT_TITLE, selectIcon());
  private readonly markerButton = iconButton('bookmark', 'Mark where you stopped reading: click this, then click a line', { 'aria-pressed': 'false' });
  private readonly markerMenu = menuToggle('Reading marker options');
  private readonly markerSplit: HTMLElement;
  private readonly undoButton = iconButton('discard', 'Undo', { class: 'mpv-btn mpv-undo-button' });
  private readonly soundsButton = h(
    'button',
    {
      class: 'mpv-btn mpv-sounds-button',
      type: 'button',
      title: 'Reading sounds',
      'aria-label': 'Reading sounds',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      hidden: true,
    },
    headphonesIcon(),
  );
  private readonly themeButton = iconButton('color-mode', DARK_TITLE, { 'aria-pressed': 'false' });
  private readonly downloadButton = iconButton('download', DOWNLOAD_TITLE);
  private readonly downloadMenu = menuToggle('Download options');
  private readonly downloadSplit: HTMLElement;
  private readonly moreButton = iconButton('ellipsis', 'More', { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  private goTo?: { element: HTMLElement; input: HTMLInputElement; count: HTMLElement };

  private size: SizeClass = 'wide';
  private width = 0;
  private kind: DocumentKind = 'markdown';
  private page = 1;
  private pages = 0;
  private zoom: ZoomValue = 'page-width';
  private theme: PageTheme = 'light';
  private fullView = false;
  private markerExists = false;
  private soundsAvailable = false;

  constructor(private readonly actions: ToolbarActions) {
    const zoomOut = iconButton('remove', `Zoom out (${MOD_KEY}+-)`);
    const zoomIn = iconButton('add', `Zoom in (${MOD_KEY}+=)`);

    // "n / N": the field and the count are one line of text.
    this.pageStep = h(
      'div',
      { class: 'mpv-step', role: 'group', 'aria-label': 'Page' },
      this.prevButton,
      h('label', { class: 'mpv-step-value mpv-page' }, h('span', { class: 'mpv-page-line' }, this.pageInput, this.pageCount)),
      this.nextButton,
    );
    this.zoomStep = h('div', { class: 'mpv-step', role: 'group', 'aria-label': 'Zoom' }, zoomOut, this.zoomButton, zoomIn);
    this.markerSplit = h('div', { class: 'mpv-split' }, this.markerButton, this.markerMenu);
    this.downloadSplit = h('div', { class: 'mpv-split' }, this.downloadButton, this.downloadMenu);
    const tools = h('div', { class: 'mpv-seg mpv-seg-tools', role: 'group', 'aria-label': 'Tools' }, this.selectButton, this.highlightButton, this.drawButton, this.textButton);

    this.element = h(
      'header',
      { class: 'mpv-toolbar', role: 'toolbar', 'aria-label': 'Reading Room' },
      h('div', { class: 'mpv-zone' }, this.listButton, this.pageStep, this.zoomStep),
      h('span', { class: 'mpv-grow' }),
      h('div', { class: 'mpv-zone' }, tools, this.markerSplit, this.undoButton),
      h('span', { class: 'mpv-grow' }),
      h('div', { class: 'mpv-zone-tight' }, this.soundsButton, this.themeButton, this.downloadSplit, this.moreButton),
    );
    this.setMarkerState(false, false);

    this.listButton.addEventListener('click', () => actions.toggleList());
    this.prevButton.addEventListener('click', () => actions.previousPage());
    this.nextButton.addEventListener('click', () => actions.nextPage());
    zoomOut.addEventListener('click', () => actions.zoomOut());
    zoomIn.addEventListener('click', () => actions.zoomIn());
    this.zoomButton.addEventListener('click', (e) => this.openZoom(this.zoomButton, byKeyboard(e), true));
    this.highlightButton.addEventListener('click', () => actions.toggleTool());
    this.drawButton.addEventListener('click', () => actions.toggleDrawing());
    this.textButton.addEventListener('click', () => actions.toggleText());
    this.selectButton.addEventListener('click', () => actions.toggleSelect());
    // The button does not take the keyboard: while typing in a text box, it undoes the typing.
    this.undoButton.addEventListener('pointerdown', (e) => e.preventDefault());
    this.undoButton.addEventListener('click', () => actions.undo());
    this.markerButton.addEventListener('click', () => actions.placeMarker());
    this.markerMenu.addEventListener('click', (e) =>
      menu().toggle(this.markerMenu, 'Reading marker', this.markerParts(true), { align: 'end', keyboard: byKeyboard(e), anchor: this.markerSplit }),
    );
    this.soundsButton.addEventListener('click', () => actions.toggleSounds(this.soundsButton));
    this.themeButton.addEventListener('click', () => actions.toggleTheme());
    this.downloadButton.addEventListener('click', () => actions.download(true));
    this.downloadMenu.addEventListener('click', (e) =>
      menu().toggle(this.downloadMenu, 'Download', this.downloadParts(false), { align: 'end', keyboard: byKeyboard(e), anchor: this.downloadSplit }),
    );
    this.moreButton.addEventListener('click', (e) => menu().toggle(this.moreButton, 'More', this.moreParts(), { align: 'end', keyboard: byKeyboard(e) }));
    // ↓ on a button that opens a menu opens it, like Enter and Space.
    for (const button of [this.zoomButton, this.markerMenu, this.downloadMenu, this.moreButton]) {
      button.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' || menu().openedFrom === button) return;
        e.preventDefault();
        button.click();
      });
    }
    this.bindPageInput(this.pageInput);
    this.setZoom('page-width', 1);
  }

  // ---------- Layout ----------

  /**
   * Fits the bar to a viewer `width` px wide: picks the size class of that width, and a narrower
   * one while the controls of the class do not fit (many pages, a long zoom value). Returns the
   * class in use, which is also set on <body> (`data-size`) for the styles.
   */
  layout(width = this.width): SizeClass {
    this.width = width;
    this.apply(sizeClassOf(width));
    for (let next = narrower(this.size); next && this.element.scrollWidth > this.element.clientWidth; next = narrower(next)) this.apply(next);
    return this.size;
  }

  private apply(size: SizeClass): void {
    this.size = size;
    document.body.dataset.size = size;
    const tight = size === 'narrow' || size === 'mini';
    this.zoomStep.hidden = size !== 'wide';
    this.downloadSplit.hidden = size !== 'wide';
    this.markerSplit.hidden = tight;
    this.soundsButton.hidden = !this.soundsAvailable || tight;
    // Dark pages is on the bar wherever there is room for it: everywhere but in a mini panel.
    this.themeButton.hidden = size === 'mini';
    // Narrow: the page field without its arrows. Mini: "Go to page…" in More.
    this.prevButton.hidden = tight;
    this.nextButton.hidden = tight;
    this.pageStep.hidden = size === 'mini';
    // What a menu was opened from may be gone, and More may list something else now.
    menu().close();
    if (this.goTo) this.goTo.element.hidden = true;
  }

  // ---------- Menus ----------

  private zoomParts(): MenuPart[] {
    const current = String(this.zoom);
    return [
      ...ZOOM_FITS.map((z) => ({ label: z.label, role: 'radio' as const, checked: current === z.value, run: () => this.actions.setZoom(z.value) })),
      'separator' as const,
      ...ZOOM_LEVELS.map((level) => ({ label: `${Math.round(level * 100)}%`, role: 'radio' as const, checked: current === String(level), run: () => this.actions.setZoom(level) })),
    ];
  }

  private openZoom(opener: HTMLElement, keyboard: boolean, toggle = false): void {
    const options = { align: opener === this.zoomButton ? ('start' as const) : ('end' as const), keyboard, anchor: opener === this.zoomButton ? this.zoomStep : opener };
    if (toggle) menu().toggle(opener, 'Zoom', this.zoomParts(), options);
    else menu().open(opener, 'Zoom', this.zoomParts(), options);
  }

  private markerParts(withRemove: boolean): MenuPart[] {
    const parts: MenuPart[] = [
      { icon: 'bookmark', label: this.size === 'mini' ? 'Mark where I stopped…' : 'Mark where I stopped reading…', run: () => this.actions.placeMarker() },
      {
        icon: 'arrow-right',
        label: this.size === 'mini' ? 'Go to where I stopped' : 'Go to where I stopped reading',
        disabled: !this.markerExists,
        run: () => this.actions.goToMarker(),
      },
    ];
    if (withRemove) parts.push({ icon: 'close', label: 'Remove the reading marker', disabled: !this.markerExists, run: () => this.actions.removeMarker() });
    return parts;
  }

  private downloadParts(short: boolean): MenuPart[] {
    return [
      { icon: pageIcon(true), label: short ? 'Download PDF' : DOWNLOAD_TITLE, run: () => this.actions.download(true) },
      {
        icon: pageIcon(false),
        label: !short ? 'Download PDF without annotations' : this.size === 'mini' ? 'Without annotations' : 'Download without annotations',
        run: () => this.actions.download(false),
      },
    ];
  }

  /** More: what is rarely needed (full view, converting again), and whatever the size class took off the bar. */
  private moreParts(): MenuPart[] {
    const { size, actions } = this;
    const tight = size === 'narrow' || size === 'mini';
    const groups: MenuPart[][] = [];
    const current = String(this.zoom);
    if (size === 'mini') {
      groups.push([
        { icon: 'file', label: 'Go to page…', end: `${this.page} / ${this.pages}`, run: () => this.openGoTo() },
        { icon: 'zoom-in', label: 'Zoom', end: this.zoomLabel.textContent ?? '', run: () => this.openZoom(this.moreButton, true) },
      ]);
    } else if (size !== 'wide') {
      groups.push([
        { icon: 'add', label: 'Zoom in', end: `${MOD_KEY}+=`, run: () => actions.zoomIn() },
        { icon: 'remove', label: 'Zoom out', end: `${MOD_KEY}+-`, run: () => actions.zoomOut() },
        ...ZOOM_FITS.slice(0, 2).map((z) => ({ icon: z.icon, label: z.label, role: 'radio' as const, checked: current === z.value, run: () => actions.setZoom(z.value) })),
        { icon: 'zoom-in', label: 'Other zoom levels', more: true, run: () => this.openZoom(this.moreButton, true) },
      ]);
    }
    if (tight) {
      const reading = this.markerParts(false);
      if (this.soundsAvailable) reading.push({ icon: headphonesIcon(), label: 'Reading sounds…', run: () => actions.toggleSounds(this.moreButton) });
      groups.push(reading);
    }
    if (size !== 'wide') groups.push(this.downloadParts(true));
    const room: MenuPart[] = [];
    if (size === 'mini') room.push({ icon: 'color-mode', label: 'Dark pages', role: 'checkbox', checked: this.theme === 'dark', run: () => actions.toggleTheme() });
    if (this.kind !== 'pdf') {
      room.push({ icon: this.fullView ? 'screen-normal' : 'screen-full', label: 'Full view', role: 'checkbox', checked: this.fullView, run: () => actions.toggleFullView() });
    }
    room.push({
      icon: 'refresh',
      label: this.kind === 'pdf' ? 'Reload from disk' : size === 'wide' ? 'Convert the document again' : 'Convert again',
      run: () => actions.refresh(),
    });
    groups.push(room);
    return groups.flatMap((group, i) => (i === 0 ? group : ['separator' as const, ...group]));
  }

  /** "Go to page…" of More (mini panels have no page field on the bar): the field, in a popover under More. */
  private openGoTo(): void {
    if (!this.goTo) {
      const input = h('input', { class: 'mpv-page-input', type: 'text', inputmode: 'numeric', 'aria-label': 'Page number' });
      const count = h('span', { class: 'mpv-page-count' });
      const element = h(
        'div',
        { class: 'mpv-popover mpv-goto', role: 'dialog', 'aria-label': 'Go to page', hidden: true },
        h(
          'div',
          { class: 'mpv-popover-row' },
          h('span', { class: 'mpv-label', text: 'Go to page' }),
          h('label', { class: 'mpv-step mpv-page' }, h('span', { class: 'mpv-step-value' }, h('span', { class: 'mpv-page-line' }, input, count))),
        ),
      );
      document.body.append(element);
      this.goTo = { element, input, count };
      const close = (focus: boolean): void => {
        element.hidden = true;
        if (focus) this.moreButton.focus();
      };
      this.bindPageInput(input, () => close(true));
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close(true);
      });
      input.addEventListener('blur', () => close(false));
    }
    const { element, input, count } = this.goTo;
    input.value = String(this.page);
    count.textContent = `/ ${this.pages}`;
    this.sizeInput(input);
    placeUnder(element, this.moreButton, 'end');
    input.focus();
  }

  // ---------- The page field ----------

  /** The field is as wide as its digits, so "n / N" is centered between what is on its two sides. */
  private sizeInput(input: HTMLInputElement): void {
    input.style.setProperty('--mpv-digits', String(Math.max(1, input.value.length)));
  }

  private bindPageInput(input: HTMLInputElement, done?: () => void): void {
    input.addEventListener('input', () => this.sizeInput(input));
    input.addEventListener('change', () => {
      const n = parseInt(input.value, 10);
      if (Number.isFinite(n)) this.actions.goToPage(n);
      // What was typed may not be a page: the field shows the page the viewer is on.
      input.value = String(this.page);
      this.sizeInput(input);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // (Prevented: the key press that follows would go to whatever gets the focus now, and press it.)
      e.preventDefault();
      input.blur();
      done?.();
    });
    input.addEventListener('focus', () => input.select());
  }

  // ---------- State ----------

  /** Adapts More to the kind of document: PDF files have no source to show next to, and are reloaded, not converted. */
  setKind(kind: DocumentKind): void {
    this.kind = kind;
  }

  setPage(page: number, count: number): void {
    this.page = page;
    this.pages = count;
    if (document.activeElement !== this.pageInput) {
      this.pageInput.value = String(page);
      this.sizeInput(this.pageInput);
    }
    const text = `/ ${count}`;
    if (this.pageCount.textContent !== text) {
      this.pageCount.textContent = text;
      this.layout();
    }
  }

  setZoom(zoom: ZoomValue, scale: number): void {
    this.zoom = zoom;
    const percent = `${Math.round(scale * 100)}%`;
    const label = ZOOM_FITS.find((z) => z.value === zoom)?.label ?? percent;
    const changed = this.zoomLabel.textContent !== label;
    this.zoomLabel.textContent = label;
    this.zoomButton.title = `Zoom: ${percent} (${MIN_ZOOM * 100}–${MAX_ZOOM * 100}%)`;
    this.zoomButton.setAttribute('aria-label', `Zoom: ${label}`);
    if (changed && this.width > 0) this.layout();
  }

  setTool(active: boolean): void {
    this.setPressed(this.highlightButton, active, active ? HIGHLIGHT_ON_TITLE : HIGHLIGHT_TITLE);
  }

  /** The highlighter's band shows the current color. */
  setColor(color: HighlightColor): void {
    this.highlightButton.style.setProperty('--mpv-band', HIGHLIGHT_HEX[color]);
  }

  setDrawing(active: boolean): void {
    this.setPressed(this.drawButton, active, active ? DRAW_ON_TITLE : DRAW_TITLE);
  }

  setText(active: boolean): void {
    this.setPressed(this.textButton, active, active ? TEXT_ON_TITLE : TEXT_TITLE);
  }

  setSelecting(active: boolean): void {
    this.setPressed(this.selectButton, active, active ? SELECT_ON_TITLE : SELECT_TITLE);
  }

  /** What the undo button would take back (`label`), or nothing. */
  setUndo(label: string | undefined, shortcut: string): void {
    this.undoButton.disabled = label === undefined;
    this.undoButton.title = label === undefined ? 'Nothing to undo' : `Undo: ${label} (${shortcut})`;
    this.undoButton.setAttribute('aria-label', this.undoButton.title);
  }

  /** The band under the pencil shows the current ink. */
  setInk(color: Ink): void {
    setInk(this.drawButton, color);
  }

  /** The band under the two A's shows the color new text gets. */
  setTextColor(color: Ink): void {
    setInk(this.textButton, color);
  }

  private setPressed(button: HTMLButtonElement, active: boolean, title: string): void {
    button.classList.toggle('mpv-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.title = title;
    button.setAttribute('aria-label', title);
  }

  /** While the marker is being placed, the whole split button looks like a tool that is on. */
  setMarkerState(exists: boolean, placing: boolean): void {
    this.markerExists = exists;
    this.markerSplit.classList.toggle('mpv-active', placing);
    this.markerButton.classList.toggle('mpv-has-marker', exists);
    this.markerButton.setAttribute('aria-pressed', String(placing));
    this.markerButton.title = placing
      ? 'Click the line where you stopped reading (Esc cancels)'
      : exists
        ? 'Move the reading marker: click this, then click a line'
        : 'Mark where you stopped reading: click this, then click a line';
    this.markerButton.setAttribute('aria-label', this.markerButton.title);
  }

  /** The button only shows when this build has reading sounds. */
  setSoundsAvailable(available: boolean): void {
    this.soundsAvailable = available;
    this.layout();
  }

  /** The reading sounds panel hangs from the headphones, or from More when they are in it. */
  get soundsAnchor(): HTMLElement | undefined {
    if (!this.soundsAvailable) return undefined;
    return this.soundsButton.hidden ? this.moreButton : this.soundsButton;
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
    this.theme = theme;
    this.setPressed(this.themeButton, theme === 'dark', theme === 'dark' ? DARK_ON_TITLE : DARK_TITLE);
  }

  setFullView(full: boolean): void {
    this.fullView = full;
  }

  setListOpen(open: boolean): void {
    this.listButton.classList.toggle('mpv-active', open);
    this.listButton.setAttribute('aria-pressed', String(open));
  }

  /** Whether the keyboard is in the toolbar or in something that hangs from it. */
  hasFocus(): boolean {
    return this.element.contains(document.activeElement);
  }
}
