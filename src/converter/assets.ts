// Request interception for the print page: an allow-list that serves the document,
// local files (read-only, through the host) and our own assets. Everything else is blocked.
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { HTTPRequest } from 'puppeteer-core';
import type { Logger } from './types';
import { EXT_PREFIX, FS_PREFIX, ORIGIN, safeDecode } from './urls';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const REMOTE_TIMEOUT_MS = 10_000;
const REMOTE_MAX_BYTES = 25 * 1024 * 1024;

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface RequestContext {
  /** Pages served by URL path on the virtual origin (the document itself, the Mermaid sandbox). */
  pages: Map<string, string>;
  assetsDir: string;
  /** Reads a local resource by URI path; undefined disables `/fs/…` (Mermaid sandbox). */
  readResource?: (uriPath: string) => Promise<Uint8Array>;
  allowRemoteImages: boolean;
  /** URI path of the folder containing the document, for friendlier warning messages. */
  docDir?: string;
  warnings: string[];
  log: Logger;
}

function friendlyPath(uriPath: string, docDir?: string): string {
  if (docDir && uriPath.toLowerCase().startsWith(docDir.toLowerCase() + '/')) return uriPath.slice(docDir.length + 1);
  return /^\/[a-zA-Z]:\//.test(uriPath) ? uriPath.slice(1).replace(/\//g, '\\') : uriPath;
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; name?: unknown; message?: unknown };
    if (typeof e.code === 'string') return e.code === 'FileNotFound' || e.code === 'ENOENT' ? 'not found' : e.code;
    if (e.name === 'EntryNotFound (FileSystemError)' || /not ?found|ENOENT/i.test(String(e.message))) return 'not found';
    if (typeof e.message === 'string') return e.message;
  }
  return String(err);
}

function warnOnce(ctx: RequestContext, message: string): void {
  if (!ctx.warnings.includes(message)) {
    ctx.warnings.push(message);
    ctx.log.warn(message);
  }
}

async function fetchRemoteImage(url: string): Promise<{ body: Uint8Array; contentType: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? mimeFor(new URL(url).pathname);
  if (!/^image\//i.test(contentType) && !/\.(svg|png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(new URL(url).pathname)) {
    throw new Error(`unexpected content type ${contentType}`);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > REMOTE_MAX_BYTES) throw new Error('image is larger than 25 MB');
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > REMOTE_MAX_BYTES) throw new Error('image is larger than 25 MB');
  return { body: buffer, contentType };
}

async function respond(request: HTTPRequest, status: number, contentType: string, body: Uint8Array | string): Promise<void> {
  await request.respond({
    status,
    contentType,
    headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    body: typeof body === 'string' ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength),
  });
}

export function createRequestHandler(ctx: RequestContext): (request: HTTPRequest) => Promise<void> {
  const assetsRoot = resolve(ctx.assetsDir);
  return async (request) => {
    if (request.isInterceptResolutionHandled()) return;
    const rawUrl = request.url();
    try {
      if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) {
        await request.continue();
        return;
      }
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        await request.abort('addressunreachable');
        return;
      }

      if (url.origin === ORIGIN) {
        const page = ctx.pages.get(url.pathname);
        if (page !== undefined) {
          await respond(request, 200, 'text/html; charset=utf-8', page);
          return;
        }
        if (url.pathname.startsWith(EXT_PREFIX + '/')) {
          const rel = url.pathname.slice(EXT_PREFIX.length + 1).split('/').map(safeDecode).join(sep);
          const file = resolve(join(assetsRoot, rel));
          if (!file.startsWith(assetsRoot + sep)) throw new Error('asset path escapes the assets folder');
          await respond(request, 200, mimeFor(file), await readFile(file));
          return;
        }
        if (url.pathname.startsWith(FS_PREFIX + '/') && ctx.readResource) {
          const uriPath = url.pathname.slice(FS_PREFIX.length).split('/').map(safeDecode).join('/');
          try {
            await respond(request, 200, mimeFor(uriPath), await ctx.readResource(uriPath));
          } catch (err) {
            const kind = request.resourceType() === 'image' ? 'Image' : 'Resource';
            warnOnce(ctx, `${kind} ${errorCode(err)}: ${friendlyPath(uriPath, ctx.docDir)}`);
            await respond(request, 404, 'text/plain', '');
          }
          return;
        }
        if (url.pathname !== '/favicon.ico') warnOnce(ctx, `Blocked request: ${url.pathname}`);
        await request.abort('blockedbyclient');
        return;
      }

      if ((url.protocol === 'http:' || url.protocol === 'https:') && request.resourceType() === 'image') {
        if (!ctx.allowRemoteImages) {
          warnOnce(ctx, `Remote image not loaded (disabled in settings): ${rawUrl}`);
          await request.abort('blockedbyclient');
          return;
        }
        try {
          const { body, contentType } = await fetchRemoteImage(rawUrl);
          await respond(request, 200, contentType, body);
        } catch (err) {
          warnOnce(ctx, `Remote image could not be loaded (${errorCode(err)}): ${rawUrl}`);
          await respond(request, 404, 'text/plain', '');
        }
        return;
      }

      warnOnce(ctx, `Blocked ${request.resourceType()} request: ${rawUrl}`);
      await request.abort('blockedbyclient');
    } catch (err) {
      ctx.log.error(`Request handling failed for ${rawUrl}: ${String(err)}`);
      if (!request.isInterceptResolutionHandled()) await request.abort('failed').catch(() => undefined);
    }
  };
}
