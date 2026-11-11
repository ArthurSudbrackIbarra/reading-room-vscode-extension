// The color picker of drawings and text boxes: preset colors (with their own shade on dark
// pages), the custom colors used lately, and a full picker (saturation/brightness area, hue
// slider, hex field). One instance is shared by the bars and the popovers.
import {
  INK_PRESETS,
  INK_PRESET_NAMES,
  INK_PRESET_SHADES,
  MAX_RECENT_COLORS,
  hexToRgb,
  hsvToRgb,
  inkName,
  isInkPreset,
  normalizeHex,
  rgbToHex,
  rgbToHsv,
  type HexColor,
  type Ink,
} from '../src/shared/colors';
import { h, placeFloating } from './dom';
import { setInk } from './drawings';
import { chevronIcon } from './icons';

export interface ColorPickerRequest {
  /** What the color is for, e.g. "Ink color" (the picker's label). */
  label: string;
  value: Ink;
  /**
   * The color changed. `final` is false while the reader drags in the picker (show it, but do not
   * record it yet); a final call always follows.
   */
  onChange(ink: Ink, final: boolean): void;
  onClose?(): void;
}

/** A button that shows a color (a dot in its ink) and opens the picker. */
export class ColorButton {
  readonly element: HTMLButtonElement;
  private readonly dot = h('span', { class: 'mpv-color-dot', 'aria-hidden': 'true' });

  constructor(
    private readonly label: string,
    onClick: (button: HTMLButtonElement) => void,
  ) {
    this.element = h('button', { class: 'mpv-btn mpv-color-button', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, this.dot, chevronIcon());
    this.element.addEventListener('click', () => onClick(this.element));
  }

  setValue(ink: Ink): void {
    setInk(this.dot, ink);
    this.element.title = `${this.label}: ${inkName(ink)}`;
    this.element.setAttribute('aria-label', this.element.title);
  }

  set expanded(open: boolean) {
    this.element.setAttribute('aria-expanded', String(open));
    this.element.classList.toggle('mpv-active', open);
  }
}

export class ColorPicker {
  readonly element: HTMLElement;
  private request?: ColorPickerRequest;
  private anchor?: HTMLElement;
  private hsv: [number, number, number] = [0, 1, 1];
  private recent: HexColor[] = [];
  /** A custom color settled on while open: it joins the recent colors when the picker closes. */
  private settled?: HexColor;
  /** A non-final change was sent: a final one is still owed. */
  private pending = false;
  private readonly presets = new Map<Ink, HTMLButtonElement>();
  private readonly recentRow = h('div', { class: 'mpv-cp-swatches mpv-cp-recent', role: 'group', 'aria-label': 'Recent colors' });
  private readonly recentLabel = h('div', { class: 'mpv-cp-label', text: 'Recent' });
  private readonly area = h('div', { class: 'mpv-cp-area', tabindex: 0, role: 'slider', 'aria-label': 'Saturation and brightness' });
  private readonly thumb = h('span', { class: 'mpv-cp-thumb', 'aria-hidden': 'true' });
  private readonly hue = h('input', { class: 'mpv-cp-hue', type: 'range', min: 0, max: 359, step: 1, 'aria-label': 'Hue' });
  private readonly hex = h('input', { class: 'mpv-cp-hex', type: 'text', maxlength: 7, spellcheck: 'false', 'aria-label': 'Hex color' });
  private readonly preview = h('span', { class: 'mpv-cp-preview', 'aria-hidden': 'true' });
  /** The reader changed the recent colors (to remember them). */
  onRecentChanged?: (colors: HexColor[]) => void;

  constructor() {
    const grid = h('div', { class: 'mpv-cp-swatches', role: 'group', 'aria-label': 'Preset colors' });
    for (const preset of INK_PRESETS) {
      const button = this.swatch(preset, INK_PRESET_NAMES[preset]);
      this.presets.set(preset, button);
      grid.append(button);
    }
    this.area.append(this.thumb);
    this.element = h(
      'div',
      { class: 'mpv-popover mpv-color-picker', role: 'dialog', hidden: true },
      grid,
      this.recentLabel,
      this.recentRow,
      h('div', { class: 'mpv-cp-label', text: 'Custom' }),
      this.area,
      this.hue,
      h('div', { class: 'mpv-cp-row' }, this.preview, this.hex),
    );
    document.body.append(this.element);
    this.bindArea();
    this.hue.addEventListener('input', () => {
      this.hsv[0] = Number(this.hue.value);
      this.emitCustom(false);
    });
    this.hue.addEventListener('change', () => this.emitCustom(true));
    const commitHex = () => {
      const color = normalizeHex(this.hex.value);
      if (!color) {
        this.showCustom(this.currentHex());
        return;
      }
      this.hsv = rgbToHsv(hexToRgb(color));
      this.emitCustom(true, color);
    };
    this.hex.addEventListener('change', commitHex);
    this.hex.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitHex();
      }
    });
    this.element.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      const anchor = this.anchor;
      this.close();
      anchor?.focus();
    });
    // A press outside closes it (the button that opened it toggles it itself).
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.isOpen) return;
        const target = e.target as Node;
        if (!this.element.contains(target) && !this.anchor?.contains(target)) this.close();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** The element the picker was opened from (while it is open). */
  get openedFrom(): HTMLElement | undefined {
    return this.isOpen ? this.anchor : undefined;
  }

  contains(node: Node | null): boolean {
    return !!node && this.element.contains(node);
  }

  setRecent(colors: HexColor[]): void {
    this.recent = colors.slice(0, MAX_RECENT_COLORS);
    this.renderRecent();
  }

  /** Opens the picker under `anchor`, or closes it if it is already open there. */
  toggle(anchor: HTMLElement, request: ColorPickerRequest): void {
    if (this.isOpen && this.anchor === anchor) {
      this.close();
      return;
    }
    this.open(anchor, request);
  }

  open(anchor: HTMLElement, request: ColorPickerRequest): void {
    this.close();
    this.anchor = anchor;
    this.request = request;
    this.settled = undefined;
    this.pending = false;
    this.element.setAttribute('aria-label', request.label);
    this.select(request.value);
    this.renderRecent();
    const r = anchor.getBoundingClientRect();
    placeFloating(this.element, r.left + r.width / 2, r.bottom - 6);
    (this.presets.get(request.value) ?? this.area).focus({ preventScroll: true });
  }

  close(): void {
    if (!this.request) {
      this.element.hidden = true;
      return;
    }
    const request = this.request;
    if (this.pending) {
      this.pending = false;
      request.onChange(this.currentHex(), true);
    }
    this.request = undefined;
    this.anchor = undefined;
    this.element.hidden = true;
    if (this.settled) this.remember(this.settled);
    request.onClose?.();
  }

  // ---------- Parts ----------

  private swatch(ink: Ink, name: string): HTMLButtonElement {
    const button = h('button', { class: 'mpv-cp-swatch', type: 'button', title: name, 'aria-label': name, 'aria-pressed': 'false' });
    setInk(button, ink);
    button.addEventListener('click', () => this.pick(ink));
    button.addEventListener('keydown', (e) => this.moveFocus(e, button));
    return button;
  }

  /** Arrow keys move between the swatches of the picker (six per row). */
  private moveFocus(e: KeyboardEvent, from: HTMLButtonElement): void {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 };
    const step = steps[e.key];
    if (step === undefined) return;
    const all = [...this.element.querySelectorAll<HTMLButtonElement>('.mpv-cp-swatch')];
    const next = all[all.indexOf(from) + step];
    if (!next) return;
    e.preventDefault();
    next.focus();
  }

  private renderRecent(): void {
    const value = this.request?.value;
    this.recentRow.replaceChildren(
      ...this.recent.map((color) => {
        const button = this.swatch(color, color);
        const on = color === value;
        button.classList.toggle('mpv-selected', on);
        button.setAttribute('aria-pressed', String(on));
        return button;
      }),
    );
    this.recentRow.hidden = this.recent.length === 0;
    this.recentLabel.hidden = this.recent.length === 0;
  }

  /** Shows a value: its swatch is marked, and the custom part shows its light-page color. */
  private select(value: Ink): void {
    for (const [ink, button] of this.presets) {
      const on = ink === value;
      button.classList.toggle('mpv-selected', on);
      button.setAttribute('aria-pressed', String(on));
    }
    const hex = isInkPreset(value) ? INK_PRESET_SHADES[value].light : value;
    this.hsv = rgbToHsv(hexToRgb(hex));
    this.showCustom(normalizeHex(hex) ?? '#000000');
  }

  private currentHex(): HexColor {
    return rgbToHex(hsvToRgb(...this.hsv));
  }

  private showCustom(hex: HexColor): void {
    const [hue, s, v] = this.hsv;
    this.area.style.setProperty('--hue', String(Math.round(hue)));
    this.thumb.style.left = `${(s * 100).toFixed(2)}%`;
    this.thumb.style.top = `${((1 - v) * 100).toFixed(2)}%`;
    this.area.setAttribute('aria-valuetext', `Saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`);
    this.hue.value = String(Math.round(hue));
    if (document.activeElement !== this.hex) this.hex.value = hex;
    this.preview.style.background = hex;
    this.thumb.style.background = hex;
  }

  private pick(ink: Ink): void {
    const request = this.request;
    if (!request) return;
    this.pending = false;
    request.onChange(ink, true);
    this.close();
  }

  /** The custom part changed: tell the requester, marking no preset. */
  private emitCustom(final: boolean, exact?: HexColor): void {
    const request = this.request;
    if (!request) return;
    const hex = exact ?? this.currentHex();
    for (const button of this.presets.values()) button.classList.remove('mpv-selected');
    this.showCustom(hex);
    request.value = hex;
    this.pending = !final;
    if (final) this.settled = hex;
    request.onChange(hex, final);
  }

  private remember(color: HexColor): void {
    const next = [color, ...this.recent.filter((c) => c !== color)].slice(0, MAX_RECENT_COLORS);
    if (next.join() === this.recent.join()) return;
    this.recent = next;
    this.onRecentChanged?.(next);
  }

  private bindArea(): void {
    const fromPointer = (e: PointerEvent) => {
      const r = this.area.getBoundingClientRect();
      const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      this.hsv = [this.hsv[0], s, v];
    };
    this.area.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.area.focus({ preventScroll: true });
      this.area.setPointerCapture(e.pointerId);
      fromPointer(e);
      this.emitCustom(false);
    });
    this.area.addEventListener('pointermove', (e) => {
      if (!this.area.hasPointerCapture(e.pointerId)) return;
      fromPointer(e);
      this.emitCustom(false);
    });
    const end = (e: PointerEvent) => {
      if (!this.area.hasPointerCapture(e.pointerId)) return;
      this.area.releasePointerCapture(e.pointerId);
      this.emitCustom(true);
    };
    this.area.addEventListener('pointerup', end);
    this.area.addEventListener('pointercancel', end);
    this.area.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      const [hue, s, v] = this.hsv;
      this.hsv = [hue, Math.min(1, Math.max(0, s + move[0])), Math.min(1, Math.max(0, v + move[1]))];
      this.emitCustom(true);
    });
  }
}
