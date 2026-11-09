// Markdown → HTML with markdown-it and the same plugin set as VS Code's preview
// (plus GitHub-style alerts and task lists). Nothing here touches the file system.
import MarkdownIt, { type MarkdownIt as MarkdownItInstance, type Token } from 'markdown-it';
import anchor from 'markdown-it-anchor';
import GithubSlugger from 'github-slugger';
import footnote from 'markdown-it-footnote';
import { tasklist } from '@mdit/plugin-tasklist';
import { full as emoji } from 'markdown-it-emoji';
import katex from '@vscode/markdown-it-katex';
import frontMatter from 'markdown-it-front-matter';
import { alert } from '@mdit/plugin-alert';
import { resolveResourceUrl, rewriteHtmlUrls, type UrlContext } from './urls';
import { escapeHtml, plainCodeHtml, type CodeHighlighter } from './highlight';

export interface MarkdownEnv {
  urlContext: UrlContext;
  highlighter?: CodeHighlighter;
  /** Mermaid sources, in document order. The HTML gets `<div class="mermaid-slot" data-i>` placeholders. */
  mermaid: string[];
  frontMatterRaw?: string;
}

export interface ParsedMarkdown {
  tokens: Token[];
  env: MarkdownEnv;
  md: MarkdownItInstance;
  /** Fence languages used in the document (for preloading grammars). */
  languages: Set<string>;
  title?: string;
}

const UNSAFE_PROTOCOL_RE = /^\s*(javascript|vbscript):/i;
const DATA_RE = /^\s*data:/i;
const SAFE_DATA_IMAGE_RE = /^\s*data:image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp);/i;

function fenceLanguage(md: MarkdownItInstance, info: string): string {
  const unescaped = info ? md.utils.unescapeAll(info).trim() : '';
  // Accept "```ts title=x", "```{.python}" and "```ts{1,3}" styles.
  const match = /^\{?\.?([^\s{}]+)/.exec(unescaped);
  return match ? match[1] : '';
}

function createMarkdownIt(onFrontMatter: (raw: string) => void): MarkdownItInstance {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });

  // markdown-it rejects file: URLs by default. VS Code's preview allows them, and so do we,
  // but script URLs are still blocked and data: is only allowed for images.
  md.validateLink = (url: string) => !UNSAFE_PROTOCOL_RE.test(url) && (!DATA_RE.test(url) || SAFE_DATA_IMAGE_RE.test(url));

  md.use(frontMatter, onFrontMatter);
  md.use(anchor, {
    slugifyWithState: (title: string, state: { env: Record<string, unknown> }) => {
      const env = state.env as { slugger?: GithubSlugger };
      env.slugger ??= new GithubSlugger();
      return env.slugger.slug(title);
    },
    tabIndex: false,
  });
  md.use(footnote);
  md.use(tasklist, { disabled: true, label: false });
  md.use(emoji);

  // Our fence rule is installed before the KaTeX plugin, which wraps it for ```math blocks.
  md.renderer.rules.fence = (tokens, idx, _options, rawEnv) => {
    const env = rawEnv as unknown as MarkdownEnv;
    const token = tokens[idx];
    const lang = fenceLanguage(md, token.info);
    if (lang.toLowerCase() === 'mermaid') {
      const index = env.mermaid.push(token.content) - 1;
      return `<div class="mermaid-slot" data-i="${index}"></div>\n`;
    }
    const code = env.highlighter ? env.highlighter.highlight(token.content, lang) : plainCodeHtml(token.content);
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return `<div class="code-block"${langAttr}>${code}</div>\n`;
  };
  md.renderer.rules.code_block = (tokens, idx) => `<div class="code-block">${plainCodeHtml(tokens[idx].content)}</div>\n`;

  md.use(katex, {
    enableBareBlocks: true,
    enableFencedBlocks: true,
    enableMathBlockInHtml: true,
    enableMathInlineInHtml: true,
    throwOnError: false,
    // Only the visual HTML: hidden MathML would add duplicate text to the PDF text layer.
    output: 'html',
  } as Parameters<typeof katex>[1]);
  md.use(alert);

  const renderImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, rawEnv, self) => {
    const env = rawEnv as unknown as MarkdownEnv;
    const token = tokens[idx];
    const src = token.attrGet('src');
    if (src !== null && src !== undefined) token.attrSet('src', resolveResourceUrl(String(src), env.urlContext));
    return renderImage(tokens, idx, options, rawEnv, self);
  };

  const renderLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, rawEnv, self) => {
    const env = rawEnv as unknown as MarkdownEnv;
    const token = tokens[idx];
    const href = token.attrGet('href');
    if (href !== null && href !== undefined) token.attrSet('href', resolveResourceUrl(String(href), env.urlContext));
    return renderLinkOpen(tokens, idx, options, rawEnv, self);
  };

  const renderHtmlBlock = md.renderer.rules.html_block!;
  md.renderer.rules.html_block = (tokens, idx, options, rawEnv, self) => {
    const env = rawEnv as unknown as MarkdownEnv;
    tokens[idx].content = rewriteHtmlUrls(tokens[idx].content, env.urlContext);
    return renderHtmlBlock(tokens, idx, options, rawEnv, self);
  };
  const renderHtmlInline = md.renderer.rules.html_inline!;
  md.renderer.rules.html_inline = (tokens, idx, options, rawEnv, self) => {
    const env = rawEnv as unknown as MarkdownEnv;
    tokens[idx].content = rewriteHtmlUrls(tokens[idx].content, env.urlContext);
    return renderHtmlInline(tokens, idx, options, rawEnv, self);
  };

  return md;
}

function frontMatterTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^title\s*:\s*(.+?)\s*$/m.exec(raw);
  if (!match) return undefined;
  return match[1].replace(/^(["'])(.*)\1$/, '$2').trim() || undefined;
}

function firstHeading(tokens: Token[]): string | undefined {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type === 'heading_open' && tokens[i].tag === 'h1') {
      const inline = tokens[i + 1];
      const text = (inline.children ?? [])
        .filter((t) => t.type === 'text' || t.type === 'code_inline' || t.type === 'emoji')
        .map((t) => t.content)
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return undefined;
}

/** First pass: parse the Markdown and collect what the async steps need (languages, title). */
export function parseMarkdown(source: string, urlContext: UrlContext): ParsedMarkdown {
  let rawFrontMatter: string | undefined;
  const md = createMarkdownIt((raw) => {
    rawFrontMatter = raw;
  });
  const env: MarkdownEnv = { urlContext, mermaid: [] };
  const tokens = md.parse(source, env as unknown as Record<string, unknown>);
  env.frontMatterRaw = rawFrontMatter;
  const languages = new Set<string>();
  for (const token of tokens) {
    if (token.type === 'fence') languages.add(fenceLanguage(md, token.info));
  }
  return { tokens, env, md, languages, title: frontMatterTitle(rawFrontMatter) ?? firstHeading(tokens) };
}

/** Second pass: render the parsed tokens to HTML with a ready highlighter. */
export function renderParsed(parsed: ParsedMarkdown, highlighter: CodeHighlighter): string {
  parsed.env.highlighter = highlighter;
  parsed.env.mermaid = [];
  return parsed.md.renderer.render(parsed.tokens, parsed.md.options, parsed.env as unknown as Record<string, unknown>);
}
