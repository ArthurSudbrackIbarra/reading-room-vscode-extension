// Plain text → HTML: the text exactly as written (monospace, long lines wrapped), with
// http(s) and mailto addresses turned into links. Nothing here touches the file system.
import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it';
import { escapeHtml } from './highlight';

type Linkify = MarkdownItInstance['linkify'];
let linkify: Linkify | undefined;

function linkifier(): Linkify {
  if (!linkify) {
    linkify = new MarkdownIt('zero', { linkify: true }).linkify;
    // Only explicit addresses: "readme.md" or "notes.txt" must stay plain text.
    linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  }
  return linkify;
}

/** Normalizes line endings and drops a byte order mark. */
export function normalizeText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export function plainTextToHtml(text: string): string {
  const source = normalizeText(text);
  let html = '';
  let last = 0;
  for (const match of linkifier().match(source) ?? []) {
    if (!/^(https?:\/\/|mailto:)/i.test(match.url)) continue;
    html += escapeHtml(source.slice(last, match.index));
    html += `<a href="${escapeHtml(match.url)}">${escapeHtml(match.raw)}</a>`;
    last = match.lastIndex;
  }
  html += escapeHtml(source.slice(last));
  // A trailing newline would add an empty line at the end of the last page.
  return `<pre class="plain-text">${html.replace(/\n$/, '')}</pre>`;
}
