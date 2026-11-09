// Tiny DOM helpers (no framework; the CSP forbids inline styles in markup, so styles go through CSSOM).
type Attrs = Record<string, string | number | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | undefined | false)[]
): HTMLElementTagNameMap[K] {
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

/** Positions a floating element near a point, keeping it inside the window. */
export function placeFloating(el: HTMLElement, x: number, y: number, below = true): void {
  el.style.left = '0px';
  el.style.top = '0px';
  el.hidden = false;
  const { width, height } = el.getBoundingClientRect();
  const margin = 6;
  let left = x - width / 2;
  let top = below ? y + 10 : y - height - 10;
  if (top + height > window.innerHeight - margin) top = y - height - 10;
  if (top < margin) top = Math.min(window.innerHeight - height - margin, y + 10);
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}
