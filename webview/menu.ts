// Menus: one floating panel of rows, used by everything that opens a list of commands or of
// values (the zoom, the reading marker, download, More, the font size, what a drawing follows).
// One menu is open at a time. Keyboard: ↑ ↓ move, Home and End jump, Enter or Space picks, Esc
// closes and gives the keyboard back to the control that opened it; typing jumps to an item.
import { h, icon, placeUnder } from './dom';
import { checkIcon, chevronIcon } from './icons';

export interface MenuItem {
  label: string;
  /** A codicon name, or an icon element. */
  icon?: string | SVGElement;
  /** Text at the right end: a shortcut, the current value. */
  end?: string;
  /** One of several values (`radio`) or a setting that is on or off (`checkbox`): a check at the right end when `checked`. */
  role?: 'radio' | 'checkbox';
  checked?: boolean;
  disabled?: boolean;
  /** It opens something else: an arrow at the right end. */
  more?: boolean;
  run(): void;
}

/** An item, a dividing line, or a line of small print at the top. */
export type MenuPart = MenuItem | 'separator' | { head: string };

export interface MenuOptions {
  /** Which edge of the opener the menu lines up with. */
  align?: 'start' | 'end';
  /** Opened with the keyboard: the current item (or the first) gets the focus. */
  keyboard?: boolean;
  /** The keyboard stays where it is (a text box being typed in): nothing in the menu takes the focus. */
  keepFocus?: boolean;
  /** A narrow list of short values (font sizes). */
  narrow?: boolean;
  /** Hang the menu from this element instead of the opener (which still gets the keyboard back). */
  anchor?: HTMLElement;
}

function isItem(part: MenuPart): part is MenuItem {
  return typeof part === 'object' && 'label' in part;
}

export class Menu {
  readonly element = h('div', { class: 'mpv-menu', role: 'menu', tabindex: -1, hidden: true });
  private opener?: HTMLElement;
  private keepFocus = false;
  private typed = '';
  private typedAt = 0;

  constructor() {
    document.body.append(this.element);
    this.element.addEventListener('keydown', (e) => this.onKey(e));
    // The pointer and the keyboard mark the same item: the one that has the focus.
    this.element.addEventListener('pointermove', (e) => {
      if (this.keepFocus) return;
      const item = (e.target as Element | null)?.closest<HTMLButtonElement>('.mpv-menu-item');
      if (item && !item.disabled && document.activeElement !== item) item.focus({ preventScroll: true });
    });
    this.element.addEventListener('pointerdown', (e) => {
      if (this.keepFocus) e.preventDefault();
    });
    // A press anywhere else closes it (the control that opened it toggles it itself).
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.isOpen) return;
        const target = e.target as Node;
        if (!this.element.contains(target) && !this.opener?.contains(target)) this.close();
      },
      true,
    );
    window.addEventListener('blur', () => this.close());
    window.addEventListener('resize', () => this.close());
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** The control the menu was opened from (while it is open). */
  get openedFrom(): HTMLElement | undefined {
    return this.isOpen ? this.opener : undefined;
  }

  contains(node: Node | null): boolean {
    return !!node && this.element.contains(node);
  }

  /** Opens the menu under `opener`, or closes it when it is already open there. */
  toggle(opener: HTMLElement, label: string, parts: MenuPart[], options: MenuOptions = {}): void {
    if (this.isOpen && this.opener === opener) {
      this.close();
      return;
    }
    this.open(opener, label, parts, options);
  }

  open(opener: HTMLElement, label: string, parts: MenuPart[], options: MenuOptions = {}): void {
    this.close();
    this.opener = opener;
    this.keepFocus = options.keepFocus === true;
    this.typed = '';
    this.element.setAttribute('aria-label', label);
    this.element.classList.toggle('mpv-menu-narrow', options.narrow === true);
    this.element.replaceChildren(...parts.map((part) => this.build(part)));
    opener.setAttribute('aria-expanded', 'true');
    placeUnder(this.element, options.anchor ?? opener, options.align ?? 'start');
    const current = this.element.querySelector<HTMLButtonElement>('.mpv-menu-item[aria-checked="true"]');
    current?.scrollIntoView({ block: 'center' });
    if (this.keepFocus) return;
    if (options.keyboard) (current ?? this.items()[0] ?? this.element).focus({ preventScroll: true });
    else this.element.focus({ preventScroll: true });
  }

  close(restoreFocus = false): void {
    if (!this.isOpen) return;
    const opener = this.opener;
    const hadFocus = this.element.contains(document.activeElement);
    this.element.hidden = true;
    this.element.replaceChildren();
    this.opener = undefined;
    opener?.setAttribute('aria-expanded', 'false');
    if ((restoreFocus || hadFocus) && opener?.isConnected && !opener.hidden) opener.focus({ preventScroll: true });
  }

  private build(part: MenuPart): HTMLElement {
    if (part === 'separator') return h('div', { class: 'mpv-menu-sep', role: 'separator' });
    if (!isItem(part)) return h('div', { class: 'mpv-menu-head', text: part.head });
    const role = part.role === 'radio' ? 'menuitemradio' : part.role === 'checkbox' ? 'menuitemcheckbox' : 'menuitem';
    const glyph = typeof part.icon === 'string' ? icon(part.icon) : part.icon;
    let end: HTMLElement | undefined;
    if (part.role && part.checked) end = h('span', { class: 'mpv-menu-end' }, checkIcon());
    else if (part.more) end = h('span', { class: 'mpv-menu-end' }, icon('chevron-right'));
    else if (part.end) end = h('span', { class: 'mpv-menu-end' }, h('span', { class: 'mpv-label', text: part.end }));
    const item = h(
      'button',
      { class: 'mpv-menu-item', type: 'button', role, tabindex: -1, disabled: part.disabled, 'aria-checked': part.role ? String(part.checked === true) : undefined },
      glyph,
      h('span', { class: 'mpv-menu-label mpv-label', text: part.label }),
      end,
    );
    item.addEventListener('click', () => {
      // The keyboard goes back to the control the menu was opened from; what the item opens
      // (another menu, a panel) hangs from that control and takes the keyboard from there.
      this.close();
      part.run();
    });
    return item;
  }

  private items(): HTMLButtonElement[] {
    return [...this.element.querySelectorAll<HTMLButtonElement>('.mpv-menu-item:not(:disabled)')];
  }

  private onKey(e: KeyboardEvent): void {
    const items = this.items();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
      return;
    }
    if (e.key === 'Tab') {
      this.close(true);
      return;
    }
    if (e.key === 'ArrowDown') next = index + 1;
    else if (e.key === 'ArrowUp') next = index < 0 ? items.length - 1 : index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Typing jumps to the item that starts with what was typed ("1", "4": font size 14).
      const now = Date.now();
      this.typed = now - this.typedAt > 700 ? e.key : this.typed + e.key;
      this.typedAt = now;
      const wanted = this.typed.toLowerCase();
      const found = items.findIndex((item) => (item.querySelector('.mpv-menu-label')?.textContent ?? '').toLowerCase().startsWith(wanted));
      if (found < 0) return;
      next = found;
    } else {
      // Keys of the viewer (tools, Delete) are not for the menu's items; Enter and Space are the button's own.
      if (e.key !== 'Enter' && e.key !== ' ') e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (items.length === 0) return;
    items[(next + items.length) % items.length].focus();
  }
}

let shared: Menu | undefined;

/** The one menu of the viewer (opening it somewhere closes it where it was). */
export function menu(): Menu {
  shared ??= new Menu();
  return shared;
}

/** True when a click was made with the keyboard (Enter or Space on the button). */
export function byKeyboard(e: MouseEvent): boolean {
  return e.detail === 0;
}

export interface MenuButtonOptions<T> {
  /** What the value is, for the tooltip and screen readers: "Font size". */
  label: string;
  className?: string;
  /** Small print at the top of the menu. */
  head?: string;
  options: { value: T; label: string }[];
  onPick(value: T): void;
  keepFocus?: boolean;
  narrow?: boolean;
  /** How the tooltip says a value: "12 points". */
  describe?(label: string): string;
}

/** A button that shows a value and opens a menu of values (in place of a native select). */
export class MenuButton<T> {
  readonly element: HTMLButtonElement;
  private readonly text = h('span', { class: 'mpv-label' });
  private value?: T;

  constructor(private readonly options: MenuButtonOptions<T>) {
    this.element = h(
      'button',
      { class: `mpv-select ${options.className ?? ''}`.trim(), type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      this.text,
      chevronIcon(),
    );
    this.element.addEventListener('click', (e) => this.toggle(byKeyboard(e)));
    this.element.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' || menu().openedFrom === this.element) return;
      e.preventDefault();
      e.stopPropagation();
      this.toggle(true);
    });
  }

  /** Shows a value. One that is not in the list is shown as `label` (and has no item in the menu). */
  setValue(value: T, label?: string): void {
    this.value = value;
    const shown = this.options.options.find((o) => o.value === value)?.label ?? label ?? String(value);
    this.text.textContent = shown;
    this.element.title = `${this.options.label}: ${this.options.describe ? this.options.describe(shown) : shown}`;
    this.element.setAttribute('aria-label', this.element.title);
  }

  private toggle(keyboard: boolean): void {
    const { options } = this;
    const parts: MenuPart[] = options.options.map((o) => ({
      label: o.label,
      role: 'radio' as const,
      checked: o.value === this.value,
      run: () => options.onPick(o.value),
    }));
    if (options.head) parts.unshift({ head: options.head });
    // While a text box is being typed in, the keyboard stays in it (unless the menu was opened with the keyboard).
    menu().toggle(this.element, options.label, parts, { keyboard, keepFocus: options.keepFocus === true && !keyboard, narrow: options.narrow });
  }
}
