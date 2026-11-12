// Syntax highlighting with Shiki, using VS Code's own TextMate grammars.
// Both GitHub themes are emitted as CSS variables, so the light and dark renders share
// one HTML layout and only differ in colors (see print.css).
import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from 'shiki';

const LIGHT_THEME = 'github-light-default';
const DARK_THEME = 'github-dark-default';

const PLAIN_LANGS = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'none', 'nohighlight']);
const EXTRA_ALIASES: Record<string, string> = {
  'c#': 'csharp',
  'f#': 'fsharp',
  'objective-c': 'objc',
  golang: 'go',
  sh: 'shellscript',
  zsh: 'shellscript',
  bat: 'batch',
  cmd: 'batch',
  vue: 'vue',
  docker: 'dockerfile',
  'shell-session': 'shellsession',
};

let highlighterPromise: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [LIGHT_THEME, DARK_THEME], langs: [] });
  return highlighterPromise;
}

/** Maps a fence info language to a bundled Shiki language id, or undefined for plain text. */
export function resolveLanguage(lang: string): BundledLanguage | undefined {
  const key = lang.trim().toLowerCase();
  if (PLAIN_LANGS.has(key)) return undefined;
  const mapped = EXTRA_ALIASES[key] ?? key;
  return mapped in bundledLanguages ? (mapped as BundledLanguage) : undefined;
}

export interface CodeHighlighter {
  highlight(code: string, lang: string): string;
}

/** Loads the grammars a document needs, then returns a synchronous highlighter for markdown-it. */
export async function prepareHighlighter(langs: Iterable<string>, warn: (message: string) => void): Promise<CodeHighlighter> {
  const highlighter = await getHighlighter();
  const loaded = new Set<string>(highlighter.getLoadedLanguages());
  const wanted = new Set<BundledLanguage>();
  for (const lang of langs) {
    const id = resolveLanguage(lang);
    if (id && !loaded.has(id)) wanted.add(id);
  }
  await Promise.all([...wanted].map((id) => highlighter.loadLanguage(id).catch((err: unknown) => warn(`Could not load the syntax grammar for "${id}": ${String(err)}`))));
  const available = new Set<string>(highlighter.getLoadedLanguages());

  return {
    highlight(code: string, lang: string): string {
      const id = resolveLanguage(lang);
      if (id && available.has(id)) {
        try {
          return highlighter.codeToHtml(code, {
            lang: id,
            themes: { light: LIGHT_THEME, dark: DARK_THEME },
            defaultColor: false,
          });
        } catch (err) {
          warn(`Syntax highlighting failed for a "${lang}" block: ${String(err)}`);
        }
      }
      return plainCodeHtml(code);
    },
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function plainCodeHtml(code: string): string {
  const body = code.replace(/\n$/, '');
  return `<pre class="shiki plain"><code>${escapeHtml(body)}</code></pre>`;
}
