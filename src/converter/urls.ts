// URL handling for the print page.
//
// The document is loaded from a virtual origin that never touches the network:
//   https://md-pdf.invalid/fs/<URI path of the .md file>.__pdf__.html
// so relative image and link URLs resolve against the Markdown file's folder exactly like
// they would on disk. Requests to the origin are answered by request interception
// (see assets.ts): `/fs/…` reads files through the host, `/__ext__/…` serves our own assets.

export const ORIGIN = 'https://md-pdf.invalid';
export const FS_PREFIX = '/fs';
export const EXT_PREFIX = '/__ext__';
export const DOC_SUFFIX = '.__pdf__.html';

export interface UrlContext {
  /** URI path of the Markdown file. */
  docPath: string;
  /** URI path of the workspace folder, if any. */
  workspaceRootPath?: string;
}

function encodePath(uriPath: string): string {
  return uriPath
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/');
}

export function fsUrl(uriPath: string): string {
  const path = uriPath.startsWith('/') ? uriPath : `/${uriPath}`;
  return ORIGIN + FS_PREFIX + encodePath(path);
}

export function documentUrl(docPath: string): string {
  return fsUrl(docPath) + encodeURIComponent(DOC_SUFFIX);
}

export function extUrl(relativePath: string): string {
  return `${ORIGIN}${EXT_PREFIX}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Decodes percent-escapes without throwing on malformed input. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%([0-9a-f]{2})/gi, (match, hex: string) => {
      const code = parseInt(hex, 16);
      return code < 0x80 ? String.fromCharCode(code) : match;
    });
  }
}

function splitSuffix(value: string): { path: string; suffix: string } {
  const index = value.search(/[?#]/);
  return index === -1 ? { path: value, suffix: '' } : { path: value.slice(0, index), suffix: value.slice(index) };
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_PATH_RE = /^[a-zA-Z]:[\\/]/;

/**
 * Turns a URL written in the Markdown (image source or link target) into something the
 * print page can load or link to. Relative URLs are left alone: they already resolve
 * against the document URL. Absolute local paths are mapped onto the virtual origin.
 */
export function resolveResourceUrl(raw: string, ctx: UrlContext): string {
  const value = raw.trim();
  if (value === '' || value.startsWith('#')) return value;

  const decoded = safeDecode(value);
  if (WINDOWS_PATH_RE.test(decoded)) {
    const { path, suffix } = splitSuffix(decoded.replace(/\\/g, '/'));
    return fsUrl(`/${path}`) + suffix;
  }
  if (value.startsWith('//')) return `https:${value}`;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.host && url.host !== 'localhost') return value; // UNC share: leave as is
      return fsUrl(safeDecode(url.pathname)) + url.search + url.hash;
    } catch {
      return value;
    }
  }
  if (SCHEME_RE.test(value)) return value;
  if (value.startsWith('/') || value.startsWith('\\')) {
    const { path, suffix } = splitSuffix(decoded.replace(/\\/g, '/'));
    const root = ctx.workspaceRootPath?.replace(/\/+$/, '');
    return fsUrl(root ? root + path : path) + suffix;
  }
  return value;
}

const URL_ATTRS = new Set(['src', 'href', 'poster']);
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*?)?(\/?)>/g;
const ATTR_RE = /(\s)([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+)/g;

/** Rewrites src/href/poster attributes inside raw HTML written in the Markdown. */
export function rewriteHtmlUrls(html: string, ctx: UrlContext): string {
  return html.replace(TAG_RE, (tag, name: string, attrs: string | undefined, selfClose: string) => {
    if (!attrs) return tag;
    const rewritten = attrs.replace(ATTR_RE, (match, space: string, attr: string, eq: string, quoted: string) => {
      if (!URL_ATTRS.has(attr.toLowerCase())) return match;
      const quote = quoted.startsWith('"') || quoted.startsWith("'") ? quoted[0] : '';
      const value = quote ? quoted.slice(1, -1) : quoted;
      const resolved = resolveResourceUrl(decodeHtmlEntities(value), ctx);
      const escaped = resolved.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return `${space}${attr}${eq}"${escaped}"`;
    });
    return `<${name}${rewritten}${selfClose}>`;
  });
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
