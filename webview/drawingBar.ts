// The mode bars: a second toolbar row, docked under the main one, shown only while drawing or
// adding text. Same height, button size and spacing as the main toolbar; groups are set apart by
// space (no divider lines), the mode's name on the left and Done on the right.
//  DRAW  [pen] [line] [arrow] [rect] [ellipse] [eraser]   [● ▾]   [─] [━] [▬]            [✓ Done]
//  TEXT  [12 ▾]   [B] [I] [U]   [≡] [≡] [≡] [≡]   [● ▾]                                  [✓ Done]
// The controls of the color, widths and text style are shared with the popovers.
import type { Ink } from '../src/shared/colors';
import {
  ALIGN_NAMES,
  DRAWING_TOOLS,
  INK_WIDTHS,
  TEXT_ALIGNS,
  TEXT_SIZES,
  WIDTH_NAMES,
  type DrawTool,
  type InkWidth,
  type TextAlign,
  type TextStyle,
} from '../src/shared/drawings';
import { ColorButton } from './colorPicker';
import { h } from './dom';
import { alignIcon, boldIcon, checkIcon, eraserIcon, italicIcon, toolIcon, underlineIcon, widthIcon } from './icons';

export const TOOL_TITLES: Record<DrawTool, string> = {
  pen: 'Pen (P)',
  line: 'Line (L): Shift snaps the angle',
  arrow: 'Arrow (A): Shift snaps the angle',
  rect: 'Rectangle (R): Shift draws a square',
  ellipse: 'Ellipse (O): Shift draws a circle',
  eraser: 'Eraser (E): click or drag over drawings to delete them',
};

/** Keys that pick a tool while drawing. */
export const TOOL_KEYS: Record<string, DrawTool> = { p: 'pen', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', e: 'eraser' };

/** Radio buttons: click or arrow keys pick (roving tabindex: only the checked one is in the Tab order). */
export function bindRadios<T>(entries: [T, HTMLButtonElement][], pick: (value: T) => void): void {
  entries.forEach(([value, button], i) => {
    button.addEventListener('click', () => pick(value));
    button.addEventListener('keydown', (e) => {
      const keys: Record<string, number> = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: entries.length - 1 };
      const next = keys[e.key];
      if (next === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      const [nextValue, nextButton] = entries[(next + entries.length) % entries.length];
      pick(nextValue);
      nextButton.focus();
    });
  });
}

/** Marks the checked radio. */
export function checkRadio<T>(buttons: Map<T, HTMLButtonElement>, value: T): void {
  for (const [v, button] of buttons) {
    const on = v === value;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
    button.classList.toggle('mpv-active', on);
  }
}

/** Buttons of the text bar must not take the keyboard from the text box being edited. */
export function keepEditorFocus(el: HTMLElement): void {
  el.addEventListener('pointerdown', (e) => {
    if ((e.target as Element | null)?.closest('button')) e.preventDefault();
  });
}

function radio(label: string, value: string, content: SVGSVGElement, extra: Record<string, string> = {}): HTMLButtonElement {
  return h('button', { class: 'mpv-btn', type: 'button', role: 'radio', title: label, 'aria-label': label, 'aria-checked': 'false', tabindex: -1, 'data-value': value, ...extra }, content);
}

/** Stroke width radios (lines of 1, 2 and 4 px). */
export function widthRadios(onPick: (width: InkWidth) => void): { group: HTMLElement; set(width: InkWidth): void } {
  const group = h('div', { class: 'mpv-group', role: 'radiogroup', 'aria-label': 'Stroke width' });
  const buttons = new Map<InkWidth, HTMLButtonElement>();
  for (const width of INK_WIDTHS) {
    const button = radio(`${WIDTH_NAMES[width]} stroke`, width, widthIcon(width));
    buttons.set(width, button);
    group.append(button);
  }
  bindRadios([...buttons], onPick);
  return { group, set: (width) => checkRadio(buttons, width) };
}

export interface TextStyleControls {
  size: HTMLSelectElement;
  /** Bold, italic, underline. */
  format: HTMLElement;
  align: HTMLElement;
  set(style: TextStyle): void;
}

/** Size menu, bold/italic/underline toggles and the alignment radios of a text box. */
export function textStyleControls(onChange: (patch: Partial<TextStyle>) => void): TextStyleControls {
  const size = h('select', { class: 'mpv-select mpv-size-select', title: 'Font size (points)', 'aria-label': 'Font size in points' });
  const custom = h('option', { value: '', hidden: true });
  size.append(custom, ...TEXT_SIZES.map((n) => h('option', { value: String(n), text: String(n) })));
  size.addEventListener('change', () => {
    const value = Number(size.value);
    if (Number.isFinite(value) && value > 0) onChange({ size: value });
  });

  const toggles: { key: 'bold' | 'italic' | 'underline'; label: string; icon: SVGSVGElement }[] = [
    { key: 'bold', label: 'Bold (Ctrl+B)', icon: boldIcon() },
    { key: 'italic', label: 'Italic (Ctrl+I)', icon: italicIcon() },
    { key: 'underline', label: 'Underline (Ctrl+U)', icon: underlineIcon() },
  ];
  const format = h('div', { class: 'mpv-group', role: 'group', 'aria-label': 'Text format' });
  const toggleButtons = new Map<'bold' | 'italic' | 'underline', HTMLButtonElement>();
  let current: TextStyle | undefined;
  for (const t of toggles) {
    const label = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? t.label.replace('Ctrl', '⌘') : t.label;
    const button = h('button', { class: 'mpv-btn', type: 'button', title: label, 'aria-label': label, 'aria-pressed': 'false' }, t.icon);
    button.addEventListener('click', () => onChange({ [t.key]: !(current?.[t.key] ?? false) }));
    toggleButtons.set(t.key, button);
    format.append(button);
  }

  const align = h('div', { class: 'mpv-group', role: 'radiogroup', 'aria-label': 'Alignment' });
  const alignButtons = new Map<TextAlign, HTMLButtonElement>();
  for (const a of TEXT_ALIGNS) {
    const button = radio(ALIGN_NAMES[a], a, alignIcon(a));
    alignButtons.set(a, button);
    align.append(button);
  }
  bindRadios([...alignButtons], (a) => onChange({ align: a }));

  return {
    size,
    format,
    align,
    set(style) {
      current = style;
      const listed = (TEXT_SIZES as readonly number[]).includes(style.size);
      custom.hidden = listed;
      custom.value = listed ? '' : String(style.size);
      custom.textContent = listed ? '' : String(style.size);
      size.value = String(style.size);
      for (const [key, button] of toggleButtons) {
        button.setAttribute('aria-pressed', String(style[key]));
        button.classList.toggle('mpv-active', style[key]);
      }
      checkRadio(alignButtons, style.align);
    },
  };
}

/** The mode's name at the start of a bar ("Draw", "Text"); all bars give it the same width. */
function modeLabel(text: string): HTMLElement {
  return h('span', { class: 'mpv-modebar-label', text, 'aria-hidden': 'true' });
}

function doneButton(title: string, onClick: () => void): HTMLButtonElement {
  const button = h('button', { class: 'mpv-done', type: 'button', title, 'aria-label': title }, checkIcon(), h('span', { text: 'Done' }));
  button.addEventListener('click', onClick);
  return button;
}

export interface DrawingBarActions {
  setTool(tool: DrawTool): void;
  setWidth(width: InkWidth): void;
  /** Opens (or closes) the color picker for the ink, under `anchor`. */
  pickColor(anchor: HTMLElement): void;
  done(): void;
}

export class DrawingBar {
  readonly element: HTMLElement;
  readonly color: ColorButton;
  private readonly tools = new Map<DrawTool, HTMLButtonElement>();
  private readonly widths: ReturnType<typeof widthRadios>;

  constructor(actions: DrawingBarActions) {
    const toolGroup = h('div', { class: 'mpv-group', role: 'radiogroup', 'aria-label': 'Drawing tool' });
    for (const tool of [...DRAWING_TOOLS, 'eraser'] as DrawTool[]) {
      const button = radio(TOOL_TITLES[tool], tool, tool === 'eraser' ? eraserIcon() : toolIcon(tool), { 'data-tool': tool });
      this.tools.set(tool, button);
      toolGroup.append(button);
    }
    bindRadios([...this.tools], (tool) => actions.setTool(tool));
    this.color = new ColorButton('Ink color', (anchor) => actions.pickColor(anchor));
    this.widths = widthRadios((width) => actions.setWidth(width));
    this.element = h(
      'div',
      { class: 'mpv-modebar mpv-drawbar', role: 'toolbar', 'aria-label': 'Drawing tools', hidden: true },
      modeLabel('Draw'),
      toolGroup,
      h('div', { class: 'mpv-group' }, this.color.element),
      this.widths.group,
      h('div', { class: 'mpv-spacer' }),
      doneButton('Stop drawing (Esc)', () => actions.done()),
    );
  }

  set visible(visible: boolean) {
    this.element.hidden = !visible;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  setTool(tool: DrawTool): void {
    checkRadio(this.tools, tool);
  }

  setColor(color: Ink): void {
    this.color.setValue(color);
  }

  setWidth(width: InkWidth): void {
    this.widths.set(width);
  }

  /** Focus for the keyboard: the checked tool. */
  focusTool(): void {
    [...this.tools.values()].find((b) => b.getAttribute('aria-checked') === 'true')?.focus();
  }
}

export interface TextBarActions {
  setStyle(patch: Partial<TextStyle>): void;
  /** Opens (or closes) the color picker for the text color, under `anchor`. */
  pickColor(anchor: HTMLElement): void;
  done(): void;
}

export class TextBar {
  readonly element: HTMLElement;
  readonly color: ColorButton;
  private readonly controls: TextStyleControls;

  constructor(actions: TextBarActions) {
    this.controls = textStyleControls((patch) => actions.setStyle(patch));
    this.color = new ColorButton('Text color', (anchor) => actions.pickColor(anchor));
    this.element = h(
      'div',
      { class: 'mpv-modebar mpv-textbar', role: 'toolbar', 'aria-label': 'Text tools', hidden: true },
      modeLabel('Text'),
      h('div', { class: 'mpv-group' }, this.controls.size),
      this.controls.format,
      this.controls.align,
      h('div', { class: 'mpv-group' }, this.color.element),
      h('div', { class: 'mpv-spacer' }),
      doneButton('Stop adding text (Esc)', () => actions.done()),
    );
    keepEditorFocus(this.element);
  }

  set visible(visible: boolean) {
    this.element.hidden = !visible;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  /** Shows a style: the text box being edited or selected, or the one new text boxes get. */
  setStyle(style: TextStyle): void {
    this.controls.set(style);
    this.color.setValue(style.color);
  }
}
