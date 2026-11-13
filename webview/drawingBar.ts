// The tool trays: a second row, docked under the toolbar, shown only while a tool is on or the
// reading marker is being placed. It looks like the toolbar: same height, padding, grid and
// colors. Every tray says which mode is on (a caps label), holds its options right after that,
// and ends with Done at the right: Done, a second click on the tool and Esc all end the tool.
//   HIGHLIGHT MODE  ● ● ● ● ● │ Select text to highlight it.                    [Esc] [✓ Done]
//   DRAW MODE  [pen line arrow rect ellipse eraser] [● ▾] [─ ━ ▬]               [Esc] [✓ Done]
//   TEXT MODE  [12 ▾] [B] [I] [U] [≡ ≡ ≡ ≡] [● ▾]                               [Esc] [✓ Done]
//   SELECT MODE  [Select all] [Copy] [Paste] [Delete] │ Drag to select several… [Esc] [✓ Done]
//   MARKER MODE  Click the line where you stopped reading.                      [Esc] [Cancel]
// A group where exactly one is picked sits in a well; toggles (bold, italic, underline) stand
// alone. With the eraser picked, the three widths are its three sizes and the ink button rests.
// The controls of the color, widths and text style are shared with the popovers.
import type { Ink } from '../src/shared/colors';
import { ALIGN_NAMES, DRAWING_TOOLS, INK_WIDTHS, TEXT_ALIGNS, TEXT_SIZES, WIDTH_NAMES, type DrawTool, type InkWidth, type TextAlign, type TextStyle } from '../src/shared/drawings';
import { HIGHLIGHT_COLORS, HIGHLIGHT_HEX, type HighlightColor } from '../src/shared/types';
import { ColorButton } from './colorPicker';
import { MOD_KEY, h, icon, labelButton, swatchButton } from './dom';
import { alignIcon, boldIcon, checkIcon, italicIcon, rubberIcon, sizeIcon, toolIcon, underlineIcon, widthIcon } from './icons';
import { MenuButton } from './menu';

export const TOOL_TITLES: Record<DrawTool, string> = {
  pen: 'Pen (P)',
  line: 'Line (L): Shift snaps the angle',
  arrow: 'Arrow (A): Shift snaps the angle',
  rect: 'Rectangle (R): Shift draws a square',
  ellipse: 'Ellipse (O): Shift draws a circle',
  eraser: 'Eraser (E): drag over a drawing to rub out the part under the ring',
};

/** Keys that pick a tool while drawing. */
export const TOOL_KEYS: Record<string, DrawTool> = { p: 'pen', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', e: 'eraser' };

export const COLOR_NAMES: Record<HighlightColor, string> = {
  yellow: 'Yellow',
  pink: 'Pink',
  green: 'Green',
  blue: 'Blue',
  orange: 'Orange',
};

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
export function checkRadio<T>(buttons: Map<T, HTMLButtonElement>, value: T, className = 'mpv-active'): void {
  for (const [v, button] of buttons) {
    const on = v === value;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
    button.classList.toggle(className, on);
  }
}

/** Buttons of the text tray must not take the keyboard from the text box being edited. */
export function keepEditorFocus(el: HTMLElement): void {
  el.addEventListener('pointerdown', (e) => {
    if ((e.target as Element | null)?.closest('button')) e.preventDefault();
  });
}

function radio(label: string, value: string, content: SVGSVGElement, extra: Record<string, string> = {}): HTMLButtonElement {
  return h(
    'button',
    { class: 'mpv-btn', type: 'button', role: 'radio', title: label, 'aria-label': label, 'aria-checked': 'false', tabindex: -1, 'data-value': value, ...extra },
    content,
  );
}

const ERASER_SIZE_NAMES: Record<InkWidth, string> = { thin: 'Small', medium: 'Medium', thick: 'Large' };

export interface WidthRadios {
  group: HTMLElement;
  set(width: InkWidth): void;
  /** What the three radios pick: the width of a stroke (lines), or the size of the eraser (circles). */
  setKind(kind: 'stroke' | 'eraser'): void;
}

/** Stroke width radios in a well (lines of 1, 2 and 4 px); for the eraser, its three sizes. */
export function widthRadios(onPick: (width: InkWidth) => void): WidthRadios {
  const group = h('div', { class: 'mpv-seg', role: 'radiogroup', 'aria-label': 'Stroke width' });
  const buttons = new Map<InkWidth, HTMLButtonElement>();
  for (const width of INK_WIDTHS) {
    const button = radio(`${WIDTH_NAMES[width]} stroke`, width, widthIcon(width));
    buttons.set(width, button);
    group.append(button);
  }
  bindRadios([...buttons], onPick);
  let shown: 'stroke' | 'eraser' = 'stroke';
  return {
    group,
    set: (width) => checkRadio(buttons, width),
    setKind(kind) {
      if (kind === shown) return;
      shown = kind;
      group.setAttribute('aria-label', kind === 'eraser' ? 'Eraser size' : 'Stroke width');
      for (const [width, button] of buttons) {
        const title = kind === 'eraser' ? `${ERASER_SIZE_NAMES[width]} eraser` : `${WIDTH_NAMES[width]} stroke`;
        button.title = title;
        button.setAttribute('aria-label', title);
        button.replaceChildren(kind === 'eraser' ? sizeIcon(width) : widthIcon(width));
      }
    },
  };
}

export interface TextStyleControls {
  /** The font size: a button that opens the list of sizes. */
  size: HTMLElement;
  /** Bold, italic, underline: toggles, so they stand alone. */
  format: HTMLElement;
  /** The alignment: one of four, so it sits in a well. */
  align: HTMLElement;
  set(style: TextStyle): void;
}

/**
 * Size menu, bold/italic/underline toggles and the alignment radios of a text box.
 * `keepFocus`: picking a size leaves the keyboard in the text box being typed in.
 */
export function textStyleControls(onChange: (patch: Partial<TextStyle>) => void, keepFocus = false): TextStyleControls {
  const size = new MenuButton<number>({
    label: 'Font size',
    className: 'mpv-size-select',
    options: TEXT_SIZES.map((n) => ({ value: n, label: String(n) })),
    onPick: (value) => onChange({ size: value }),
    describe: (label) => `${label} points`,
    keepFocus,
    narrow: true,
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

  const align = h('div', { class: 'mpv-seg', role: 'radiogroup', 'aria-label': 'Alignment' });
  const alignButtons = new Map<TextAlign, HTMLButtonElement>();
  for (const a of TEXT_ALIGNS) {
    const button = radio(ALIGN_NAMES[a], a, alignIcon(a));
    alignButtons.set(a, button);
    align.append(button);
  }
  bindRadios([...alignButtons], (a) => onChange({ align: a }));

  return {
    size: size.element,
    format,
    align,
    set(style) {
      current = style;
      size.setValue(style.size, String(style.size));
      for (const [key, button] of toggleButtons) {
        button.setAttribute('aria-pressed', String(style[key]));
        button.classList.toggle('mpv-active', style[key]);
      }
      checkRadio(alignButtons, style.align);
    },
  };
}

/** Done (or Cancel) of a tray: a quiet outlined button. */
function doneButton(title: string, onClick: () => void, text = 'Done'): HTMLButtonElement {
  const cancel = text !== 'Done';
  const button = h(
    'button',
    { class: cancel ? 'mpv-btn mpv-done mpv-cancel' : 'mpv-btn mpv-done', type: 'button', title, 'aria-label': title },
    cancel ? undefined : checkIcon(),
    h('span', { class: 'mpv-label', text }),
  );
  button.addEventListener('click', onClick);
  return button;
}

/** A line that says what the tool does. In a narrow viewer it is cut with "…": the tooltip has all of it. */
function hint(text: string): HTMLElement {
  return h('span', { class: 'mpv-hint', title: text, text });
}

/** A tray: the name of its mode in caps, its controls, flexible space, the Esc key and Done. */
function tray(className: string, label: string, name: string, parts: HTMLElement[], done: HTMLButtonElement): HTMLElement {
  return h(
    'div',
    { class: `mpv-tray ${className}`, role: 'toolbar', 'aria-label': label, hidden: true },
    h('span', { class: 'mpv-caps mpv-tray-label', 'aria-hidden': 'true', text: name }),
    ...parts,
    h('span', { class: 'mpv-grow' }),
    h('span', { class: 'mpv-kbd', 'aria-hidden': 'true', text: 'Esc' }),
    done,
  );
}

class Tray {
  constructor(readonly element: HTMLElement) {}

  set visible(visible: boolean) {
    this.element.hidden = !visible;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }
}

export interface HighlightTrayActions {
  setColor(color: HighlightColor): void;
  done(): void;
}

/** The tray of the highlight tool: the five colors (the tool stays on when one is picked). */
export class HighlightTray extends Tray {
  private readonly swatches = new Map<HighlightColor, HTMLButtonElement>();

  constructor(actions: HighlightTrayActions) {
    const colors = h('div', { class: 'mpv-group', role: 'radiogroup', 'aria-label': 'Highlight color' });
    const swatches = new Map<HighlightColor, HTMLButtonElement>();
    for (const color of HIGHLIGHT_COLORS) {
      const swatch = swatchButton({
        role: 'radio',
        title: `${COLOR_NAMES[color]} highlight`,
        'aria-label': COLOR_NAMES[color],
        'aria-checked': 'false',
        tabindex: -1,
        'data-color': color,
      });
      swatch.style.setProperty('--swatch', HIGHLIGHT_HEX[color]);
      swatches.set(color, swatch);
      colors.append(swatch);
    }
    bindRadios([...swatches], (color) => actions.setColor(color));
    super(
      tray(
        'mpv-highlight-tray',
        'Highlight mode',
        'Highlight mode',
        [colors, h('span', { class: 'mpv-sep' }), hint('Select text to highlight it.')],
        doneButton('Stop highlighting (Esc)', () => actions.done()),
      ),
    );
    this.swatches = swatches;
  }

  setColor(color: HighlightColor): void {
    checkRadio(this.swatches, color, 'mpv-selected');
  }
}

/** A tray that only says what to do: placing the reading marker (which ends with Cancel). */
export class HintTray extends Tray {
  constructor(className: string, name: string, text: string, done: { title: string; text?: string; run(): void }) {
    super(
      tray(
        className,
        name,
        name,
        [hint(text)],
        doneButton(done.title, () => done.run(), done.text),
      ),
    );
  }
}

export interface SelectTrayActions {
  selectAll(): void;
  copy(): void;
  paste(): void;
  remove(): void;
  done(): void;
}

/** (Ctrl+click and Shift+click are not said here: they work with any tool, not just this one.) */
const SELECT_HINT = 'Drag on the page to select several annotations at once.';

/** The tray of the select tool: what can be done with what is selected, and how many that is. */
export class SelectTray extends Tray {
  private readonly status: HTMLElement;
  private readonly needSelection: HTMLButtonElement[];

  constructor(actions: SelectTrayActions) {
    const all = labelButton(icon('check-all'), 'Select all', `Select every highlight, drawing and text box (${MOD_KEY}+A)`);
    const copy = labelButton(icon('copy'), 'Copy', `Copy what is selected (${MOD_KEY}+C)`);
    const paste = labelButton(icon('clippy'), 'Paste', `Paste copied drawings and text boxes on the page in view (${MOD_KEY}+V)`);
    const remove = labelButton(icon('trash'), 'Delete', 'Delete what is selected (Delete)', 'mpv-btn mpv-btn-label mpv-btn-danger');
    all.addEventListener('click', () => actions.selectAll());
    copy.addEventListener('click', () => actions.copy());
    paste.addEventListener('click', () => actions.paste());
    remove.addEventListener('click', () => actions.remove());
    const status = hint(SELECT_HINT);
    status.setAttribute('role', 'status');
    super(
      tray(
        'mpv-select-tray',
        'Select mode',
        'Select mode',
        [h('div', { class: 'mpv-group', role: 'group', 'aria-label': 'Selection' }, all, copy, paste, remove), h('span', { class: 'mpv-sep' }), status],
        doneButton('Stop selecting (Esc)', () => actions.done()),
      ),
    );
    this.status = status;
    this.needSelection = [copy, remove];
    this.setCount(0);
  }

  /** How many annotations are selected: said in the tray, and Copy and Delete need at least one. */
  setCount(count: number): void {
    const text = count === 0 ? SELECT_HINT : `${count} selected`;
    this.status.textContent = text;
    this.status.title = text;
    for (const button of this.needSelection) button.disabled = count === 0;
  }
}

export interface DrawingBarActions {
  setTool(tool: DrawTool): void;
  setWidth(width: InkWidth): void;
  /** Opens (or closes) the color picker for the ink, under `anchor`. */
  pickColor(anchor: HTMLElement): void;
  done(): void;
}

export class DrawingBar extends Tray {
  readonly color: ColorButton;
  private readonly tools = new Map<DrawTool, HTMLButtonElement>();
  private readonly widths: WidthRadios;

  constructor(actions: DrawingBarActions) {
    const toolGroup = h('div', { class: 'mpv-seg', role: 'radiogroup', 'aria-label': 'Drawing tool' });
    const tools = new Map<DrawTool, HTMLButtonElement>();
    for (const tool of [...DRAWING_TOOLS, 'eraser'] as DrawTool[]) {
      const button = radio(TOOL_TITLES[tool], tool, tool === 'eraser' ? rubberIcon() : toolIcon(tool), { 'data-tool': tool });
      tools.set(tool, button);
      toolGroup.append(button);
    }
    bindRadios([...tools], (tool) => actions.setTool(tool));
    const color = new ColorButton('Ink color', (anchor) => actions.pickColor(anchor));
    const widths = widthRadios((width) => actions.setWidth(width));
    super(
      tray(
        'mpv-drawbar',
        'Draw mode',
        'Draw mode',
        [toolGroup, color.element, widths.group],
        doneButton('Stop drawing (Esc)', () => actions.done()),
      ),
    );
    this.tools = tools;
    this.color = color;
    this.widths = widths;
  }

  /** Marks the tool. While it is the eraser, the widths are its sizes and the ink button rests: the eraser has no color. */
  setTool(tool: DrawTool): void {
    checkRadio(this.tools, tool);
    this.widths.setKind(tool === 'eraser' ? 'eraser' : 'stroke');
    this.color.element.disabled = tool === 'eraser';
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

export class TextBar extends Tray {
  readonly color: ColorButton;
  private readonly controls: TextStyleControls;

  constructor(actions: TextBarActions) {
    const controls = textStyleControls((patch) => actions.setStyle(patch), true);
    const color = new ColorButton('Text color', (anchor) => actions.pickColor(anchor));
    super(
      tray(
        'mpv-textbar',
        'Text mode',
        'Text mode',
        [controls.size, controls.format, controls.align, color.element],
        doneButton('Stop adding text (Esc)', () => actions.done()),
      ),
    );
    this.controls = controls;
    this.color = color;
    keepEditorFocus(this.element);
  }

  /** Shows a style: the text box being edited or selected, or the one new text boxes get. */
  setStyle(style: TextStyle): void {
    this.controls.set(style);
    this.color.setValue(style.color);
  }
}
