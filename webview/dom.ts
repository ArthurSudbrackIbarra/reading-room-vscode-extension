// Tiny DOM helpers (no framework; the CSP forbids inline styles in markup, so styles go through CSSOM).
type Attrs = Record<string, string | number | boolean | undefined>;

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** The modifier key of shortcuts, as it is written on this platform. */
export const MOD_KEY = isMac ? '⌘' : 'Ctrl';

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key.startsWith('data-')) el.setAttribute(key, String(value));
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

export function icon(name: string): HTMLSpanElement {
  return h('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });
}

export function iconButton(name: string, title: string, attrs: Attrs = {}): HTMLButtonElement {
  return h('button', { class: 'mpv-btn', type: 'button', title, 'aria-label': title, ...attrs }, icon(name));
}

/** A button with an icon and a label in words. */
export function labelButton(glyph: Node | undefined, text: string, title: string, className = 'mpv-btn mpv-btn-label'): HTMLButtonElement {
  return h('button', { class: className, type: 'button', title, 'aria-label': title }, glyph, h('span', { class: 'mpv-label', text }));
}

/** A color to pick: a dot inside a round target. Its color comes from `--swatch`, or from the ink set on the button. */
export function swatchButton(attrs: Attrs = {}, small = false): HTMLButtonElement {
  return h('button', { class: 'mpv-swatch', type: 'button', ...attrs }, h('span', { class: small ? 'mpv-dot mpv-dot-sm' : 'mpv-dot', 'aria-hidden': 'true' }));
}

/** Floating parts keep this far from the edges of the viewer. */
const EDGE = 4;

/** Positions a floating element near a point, keeping it inside the window. */
export function placeFloating(el: HTMLElement, x: number, y: number, below = true): void {
  el.style.left = '0px';
  el.style.top = '0px';
  el.hidden = false;
  const { width, height } = el.getBoundingClientRect();
  const margin = EDGE;
  let left = x - width / 2;
  let top = below ? y + 10 : y - height - 10;
  if (top + height > window.innerHeight - margin) top = y - height - 10;
  if (top < margin) top = Math.min(window.innerHeight - height - margin, y + 10);
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(margin, top))}px`;
}

/**
 * Hangs a floating element from a control: right under it (above when there is no room below),
 * its left edge on the control's (`start`), its right edge on the control's (`end`), or centered.
 */
export function placeUnder(el: HTMLElement, anchor: HTMLElement, align: 'start' | 'end' | 'center' = 'start', gap = 4): void {
  el.style.left = '0px';
  el.style.top = '0px';
  el.hidden = false;
  const r = anchor.getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  let left = align === 'start' ? r.left : align === 'end' ? r.right - width : r.left + r.width / 2 - width / 2;
  let top = r.bottom + gap;
  if (top + height > window.innerHeight - EDGE && r.top - gap - height >= EDGE) top = r.top - gap - height;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));
  top = Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}
