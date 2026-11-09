# Markdown PDF Viewer with Highlights — Implementation Plan

> **Update, 2026-11-09 (v0.2.0):** the extension became **Document Viewer & Highlighter**. It adds:
> - PDF files in a read-only custom editor (`markdownPdfViewer.pdf`)
> - `.txt` conversion
> - notes on highlights
> - a reading marker
> - undo/redo
> - a disk cache of converted PDFs in global storage
>
> The extension ID, settings and storage format are unchanged; `CHANGELOG.md` and `README.md` describe 0.2.0. The rest of this file is the 0.1.0 plan as implemented.
>
> **Status:** Phase 1 (research and plan) was **approved on 2026-11-06**. **Phase 2 (M1–M4) was implemented on 2026-11-06** as v0.1.0; see `README.md` for usage and the build/install commands.
>
> Changes and additions during implementation:
> - **Light/dark page toggle** (user request, not in the original spec): the converter renders a dark variant (same layout, colors only: CSS variables, Shiki dual themes, Mermaid `dark`), with the page margins painted by pdf-lib. Downloads always use the light pages.
> - Relative `.md` links: PDF.js refuses `file:` URLs, so the viewer adds its own clickable layer for them (`webview/fileLinks.ts`).
> - The text layer uses the same font stacks as `print.css` (`TextLayer.fontFamilyMap`), so selection and highlight edges match the glyphs better.
> - Moving the panel (full-view toggle) pins it with `workbench.action.keepEditor`; VS Code otherwise turns a moved editor into a preview tab.
> - The *(verify)* items were checked: no `'unsafe-inline'` styles and no `'unsafe-eval'` are needed (only `'wasm-unsafe-eval'` for PDF.js decoders), and `ctrl+=` shadows the window zoom.
> - End-to-end checks ran in a standalone VS Code 1.144.1 downloaded with `@vscode/test-electron`: the installed VS Code cannot start a second instance while its background updater holds the `vscode-updating` mutex.
>
> This file is the hand-off document for implementation.
> - **Part A** is the approved plan: what we're building and why.
> - **Part B** is the implementation spec: how.
> - **Part C** describes how to verify the work.
> - **Appendix A** is the original task spec, copied verbatim. It is the source of truth for requirements. Where this plan deviates from it, a verified reason is recorded here (for example, the `Ctrl+K P` keybinding conflict).
>
> Items marked *(verify)* are design choices not yet proven in this environment. Everything else was checked on this machine during Phase 1.

---

## Part A — Approved plan

### A0. Environment (verified 2026-11-06)
- Windows 11 Home 10.0.26200, keyboard layout **pt-BR ABNT2** (`0416:00010416`).
- **VS Code 1.144.1** (commit `261c84cb1e`), Electron 43.8.3, Chromium 150, extension-host **Node 24.22.1**.
- Installed browsers:
  - **Edge 157.0.4341.42** at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
  - **Chrome 156.0.8078.79** at `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Dev tools: Node 24.9.0, npm 11.6.0, git 2.30.1. The `gh` CLI is not installed.
- 46 VS Code extensions are installed, and there is no user `keybindings.json`.
- The project folder was empty and is not a git repo yet.

### A1. Libraries

| Job | Choice (pin) | Latest release | Why |
|---|---|---|---|
| Markdown → HTML | **markdown-it 15.0.3** | Oct 2026 | Same engine as VS Code's preview, and the largest plugin set |
| Plugins | markdown-it-anchor 10.1.0 + github-slugger 2.0.0, markdown-it-footnote 4.0.0, @mdit/plugin-tasklist 1.2.0, markdown-it-emoji 3.1.0, **@vscode/markdown-it-katex 1.1.2** + katex 0.19.1, markdown-it-front-matter 0.2.4, @mdit/plugin-alert 2.1.0 (GitHub `> [!NOTE]`) | 2023–2026 | Same math syntax as VS Code's preview, and GitHub-style heading IDs. `markdown-it-task-lists` was skipped because its last release was in 2018 |
| Code highlighting | **shiki 4.6.0** | Nov 2026 | Uses VS Code's own TextMate grammars, so code looks like the editor. highlight.js 11.12 is the lighter fallback |
| Diagrams | **mermaid 12.3.0** (`dist/mermaid.min.js`, still shipped) | Nov 2026 | Needs a real DOM, so it renders inside Chromium |
| HTML → PDF | **puppeteer-core 25.16.0** + **@puppeteer/browsers 3.2.6** | Oct 2026 | Chromium print-to-PDF. Verified to produce real link annotations and an outline built from the headings |
| Viewer | **pdfjs-dist 6.5.438** components (PDFViewer, EventBus, PDFLinkService, TextLayer) | Nov 2026 | `enableDetailCanvas` keeps text crisp at 300–400% |
| Highlights in the downloaded PDF | **@cantoo/pdf-lib 2.11.1** | Sep 2026 | Maintained fork with the same API. The original `pdf-lib` 1.17.1 has had no release since Nov 2021 (320 open issues) |
| Re-anchoring | **approx-string-match 2.0.1** + scoring modelled on Hypothesis's `match-quote` | Oct 2026 | Proven W3C TextQuoteSelector matching |
| Build and test | TypeScript 6.x, **esbuild 0.28.2**, **vitest 5.1.0**, @vscode/test-cli 0.0.15, @vscode/test-electron 3.1.0, **@vscode/vsce 4.1.0** | 2026 | esbuild bundles the ESM-only puppeteer-core 25 into a CJS bundle (2.3 MB). This was tested |

**Studied or rejected:**
- **marked 18.1.3:** maintained and fast. However, footnotes, KaTeX and anchors would need a patchwork of extensions that behaves differently from VS Code's preview.
- **VS Code built-in pipeline (`markdown.api.render`):** an internal command. Its output is tied to the webview preview (`data-line` attributes, vscode-resource URIs) and to whichever preview extensions the user has installed. We use the same plugins instead.
- **yzane Markdown PDF v2.2.0** (Jul 2026, 4.3M installs, active again). **Reused:** its Chromium resolver order (setting → system Chrome → Edge/Chromium paths → download into globalStorage), JS-dialog auto-dismiss, and error hints. **Not reused:** it still writes `<name>_tmp.html` *next to the Markdown file* and loads it via `file://`, which violates our constraints.
- **md-to-pdf 5.2.5:** returns a Buffer, which is good. But it serves the folder over a localhost HTTP server (serve-handler) and uses marked 4 and full puppeteer. We replace the server with request interception on a virtual origin.
- **PDF.js highlight editor (`AnnotationEditorType.HIGHLIGHT`):** it can highlight a selection and `saveDocument()`. It has **no public API** to recreate highlights from stored text anchors, only internals such as `AnnotationEditorUIManager.highlightSelection()`. Re-anchoring needs that API, so we use a thin custom highlight layer over PDF.js's text layer and write the annotations with pdf-lib.

### A2. Getting Chromium
1. Use the `markdownPdfViewer.chromiumPath` setting if it is set and the file exists.
2. Otherwise detect an installed browser: Chrome via `@puppeteer/browsers` `computeSystemExecutablePath`, then Edge, Chromium and Brave in the standard paths for Windows, macOS and Linux. **On this machine both Chrome 156 and Edge 157 are found, so nothing is downloaded.**
3. Otherwise, **after the user agrees**, download **chrome-headless-shell** into `globalStorageUri/chromium/` with a progress notification. The win64 download is about **126 MB**, compared with 209 MB for full Chrome for Testing.

Launch settings:
- `pipe: true`, so Chromium dies with the extension host.
- Profile directory under `globalStorageUri`, wiped on start.
- One warm instance, reused and closed when idle.

Measured with Edge 157: **launch 0.65 s, first render 1.5 s, warm re-render 0.5 s.**

### A3. Architecture
```
Markdown buffer (TextDocument.getText(), read-only)
 → converter/markdown.ts  markdown-it + plugins → HTML; links/images rewritten
 → converter/mermaid.ts   diagrams → SVG in an isolated page (securityLevel: strict)
 → converter/pdf.ts       Chromium page at virtual origin https://md-pdf.invalid/
                          JS disabled; local images/fonts via request interception
                          (read-only); page.pdf() → Uint8Array
 → webview.postMessage    binary transfer, no file anywhere
viewer (webview, PDF.js) ⇄ preview/PreviewManager.ts ⇄ store/HighlightStore.ts
                                                     ⇄ export/annotate.ts (pdf-lib)
anchoring/  (pure TS, shared by webview + unit tests)
```

- **PreviewManager**
  - One panel per file.
  - Side mode uses `ViewColumn.Beside`. Full mode uses the Markdown file's own group.
  - The toolbar toggle calls `panel.reveal(column)`, which moves the panel without reloading it.
  - Re-renders on save and keeps the scroll position.
  - A `WebviewPanelSerializer` restores panels after a restart.
  - A ResizeObserver keeps fit-width and fit-page correct through split/full switches, Maximize Editor Group and Zen Mode.
- **Title button**
  - Uses `editor/title` with `when: resourceLangId == markdown`.
  - There are two menu entries, chosen by `config.markdownPdfViewer.defaultOpenMode`. Each has `alt:` set to the other mode, so Alt+click opens the other one.
- **Print styling**
  - A4 or Letter page size.
  - Headings are kept with the following content, and images and table rows are not split across pages.
  - Images are capped at the page height.
  - Wide tables wrap first, then scale down to fit.
  - The header row repeats on every page.
- **Links**
  - `#anchors` become PDF named destinations (verified), handled by PDFLinkService.
  - External links go through `env.openExternal`.
  - Relative `.md` links are rewritten to absolute `file:///…` URLs, so they keep working in external PDF readers. The viewer opens them in VS Code.
- **Highlights**
  - A selection is saved as a TextQuoteSelector `{exact, prefix, suffix}`, measured over a normalized text model of the whole document (all pages, with header and footer text excluded).
  - Hints are saved too: page, offset, and rectangles in PDF units.
  - The overlay is positioned in page-relative %, so it stays aligned at every zoom, resize, and split/full switch.
  - After a re-render each highlight is re-anchored: exact match first, then fuzzy. Anything below the threshold is marked **orphaned** and kept in the list.
- **Store**
  - One file per Markdown file: `globalStorageUri/highlights/<sha256(path)>.json` = `{version, path, zoom, highlights[]}`.
  - Writes are atomic (temp file + rename, through a serialized queue).
  - The last-used color is kept in `globalState`.
  - `onDidRenameFiles` migrates the data when a file or folder is renamed.
- **Download**
  - `showSaveDialog` defaults to the Downloads folder (honouring a relocated Windows Downloads folder) and to `<name>.pdf`.
  - By default, pdf-lib adds `/Highlight` annotations with QuadPoints, color, opacity, and an appearance stream. Verified: pdf.js reads them back, and links and the outline survive.
  - "Without highlights" saves the raw Chromium buffer.
- **Settings**
  - All settings use `"scope": "application"`, except `chromiumPath`, which is `"machine"`. Either way, workspace settings can never change the behaviour.

### A4. Keyboard-zoom check (results)
Setup: an isolated VS Code 1.144.1 instance with its own user-data-dir and extensions-dir, and a webview focused. Real, trusted key events were injected through the DevTools protocol. Synthetic JS events would not count, because VS Code forwards only `isTrusted` keydowns.

| Case | Result |
|---|---|
| Ctrl+= / Ctrl+- | **The whole window zooms** (devicePixelRatio 1→1.2 and 1→0.83). The webview also receives the keydown |
| Ctrl+0 | **Not a zoom reset.** It is "Focus into Primary Side Bar" (`workbench.action.focusSideBar`). VS Code's Reset Zoom is **Ctrl+Numpad0** |
| Webview calls `preventDefault()` | The window still zooms. VS Code's webview host (`pre/index.html`) forwards every trusted keydown and ignores `defaultPrevented` |
| Webview capture-phase `stopPropagation()` on `window` | Blocks VS Code. It works, but depends on VS Code's internal listener order |
| Contributed keybinding, `when: activeWebviewPanelId == 'viewType'` | Works: the command runs and the window doesn't zoom. The **bare viewType** matches; the `mainThreadWebview-` prefix does **not** |
| …the same, with focus in the Explorer while the PDF tab is active | ❌ The PDF zooms instead of the window |
| …plus a custom context key set from webview focus/blur | ✅ PDF focused → the PDF zooms. Explorer or editor focused → the window zooms |
| Ctrl+wheel over the webview | The window does **not** zoom, and the webview receives `ctrlKey` wheel events, so we handle them. Trackpad pinch arrives as Ctrl+wheel in Chromium; this was not tested on a physical trackpad |
| Window zoom | The webview's `devicePixelRatio` changes and its `matchMedia` change event fires, so we can re-render sharply |

**Decision:** use contributed keybindings for `ctrl+=`, `ctrl+shift+=`, `ctrl+numpad_add`, `ctrl+-`, `ctrl+shift+-`, `ctrl+numpad_subtract`, `ctrl+0` and `ctrl+numpad0`, with:

```
when: activeWebviewPanelId == 'markdownPdfViewer.preview' && markdownPdfViewer.viewerFocused
```

The keybindings stay visible and rebindable in the Keyboard Shortcuts editor.

**Keybinding conflicts.** These were checked against the 1,218 default keybindings dumped from 1.144.1, all 46 installed extensions, and the user keybindings (none exist).
- `Ctrl+K P` is **taken** by *Copy Path of Active File* (`workbench.action.files.copyPathOfActiveFile`, no when clause). → Use **`Ctrl+K Shift+P`** for the side view. It is free.
- `Ctrl+Shift+Alt+P` is **free**, so it is kept for the full view.
- For reference:
  - Free `Ctrl+K <x>` chords: a b g h j k l n q x 0–9.
  - Used `Ctrl+Shift+Alt+<letter>`: a g l o.
  - `Ctrl+K Alt+P` and `Ctrl+Alt+P` are also free. Avoid `Ctrl+Alt+<letter>`, because it equals AltGr on Windows layouts.
- On this layout, VS Code lists its own zoom keys as `ctrl+oem_plus` / `ctrl+oem_minus`. Our `ctrl+=` binding still shadowed zoomIn in the test.

### A5. Risks
- **Installed browser breaks.** Managed-PC policies or a future Chrome/Edge change could stop headless launch. Mitigation: fall back to the downloaded headless shell, with a clear error and a fix-it action.
- **Raw HTML or scripts in Markdown.** The print page runs with JS off (verified: an embedded `<script>` didn't run). Mermaid gets its own strict sandbox page. No network access except images and our own fonts and CSS.
- **Highlight edge precision.** PDF.js text-layer glyph boxes are approximate, the same as PDF.js's own highlighter, so edges may be off by part of a glyph.
- **Re-anchoring.** After heavy edits, or with repeated phrases, a highlight can land on the wrong occurrence or be orphaned. Orphans stay visible, so nothing is lost silently.
- **Renames outside VS Code** (File Explorer, `git mv`) aren't reported by `onDidRenameFiles`. Mitigation: a "Reattach highlights from…" command.
- **VS Code profiles.** `globalStorageUri` is per profile, so highlights don't carry across profiles.
- **Remote and WSL windows.** Use `extensionKind: ["ui","workspace"]` and read files through `workspace.fs`, so the extension runs locally with the local browser.
- **Size.** PDF.js, Mermaid and the Shiki grammars give a `.vsix` of roughly 10–20 MB. The converter is lazy-loaded, so activation stays fast.
- **Emoji.** They depend on the system emoji font. That's fine on Windows and macOS; Linux needs Noto Color Emoji.

### A6. Build order
1. **M1:** scaffold and converter. Create the feature-test Markdown file in `test/fixtures/` and check it visually, page by page.
2. **M2:** viewer, zoom, side/full/toggle, and re-render on save.
3. **M3:** highlights (anchoring, store, list, rename handling) with unit tests.
4. **M4:** download, README, `.vsix` packaging, and install commands. Then run the acceptance checklist using the isolated-VS-Code harness (see [C3](#c3-ui-harness-cdp)).

---

## Part B — Implementation spec

### B1. Manifest (`package.json`)
- Identity:
  - `name: "markdown-pdf-viewer"`
  - `displayName: "Markdown PDF Viewer with Highlights"`
  - `publisher: "local"` (placeholder, needed for vsce)
  - `version: "0.1.0"`
  - `license`, plus a `repository` field (or pass `--allow-missing-repository` to vsce)
- `engines.vscode: "^1.110.0"`. This means a Node 22+ extension host; puppeteer-core 25 needs Node ≥ 22.12. `@types/vscode` must be ≤ the engine version, so use `~1.110.0`. The target tested in Phase 1 is 1.144.1.
- `main: "./dist/extension.js"` (CommonJS bundle; VS Code 1.144 also supports ESM extensions, but CJS is safer).
- `extensionKind: ["ui", "workspace"]`.
- `capabilities`: `{ "untrustedWorkspaces": { "supported": true }, "virtualWorkspaces": true }`. We never execute workspace code.
- `activationEvents`: `["onStartupFinished", "onWebviewPanel:markdownPdfViewer.preview"]`. Early activation is needed so `onDidRenameFiles` migration always runs. Activation stays light because the converter bundle is `require()`d lazily.
- **viewType:** `markdownPdfViewer.preview`. **Context key:** `markdownPdfViewer.viewerFocused`.

**Commands** (category "Markdown PDF"):

| Command | Title | Palette visibility |
|---|---|---|
| `markdownPdfViewer.openPreviewToSide` | Open PDF Preview to the Side (icon `$(file-pdf)`) | `editorLangId == markdown \|\| resourceLangId == markdown` |
| `markdownPdfViewer.openPreview` | Open PDF Preview | same |
| `markdownPdfViewer.toggleFullView` | Toggle PDF Full View | `activeWebviewPanelId == 'markdownPdfViewer.preview'` |
| `markdownPdfViewer.refresh` | Refresh PDF | viewer active |
| `markdownPdfViewer.download` | Download PDF (with highlights) | viewer active |
| `markdownPdfViewer.downloadWithoutHighlights` | Download PDF without Highlights | viewer active |
| `markdownPdfViewer.zoomIn` / `zoomOut` / `zoomReset` | Zoom In / Zoom Out / Reset Zoom (PDF) | viewer active |
| `markdownPdfViewer.toggleHighlightsList` | Toggle Highlights List | viewer active |
| `markdownPdfViewer.reattachHighlights` | Reattach Highlights from Another File… | viewer active |
| `markdownPdfViewer.deleteAllHighlights` | Delete All Highlights for This File | viewer active |
| `markdownPdfViewer.revealDataFolder` | Reveal Highlight Data Folder (for backups) | always |

**Menus (`editor/title`, group `navigation`):**
```json
{ "command": "markdownPdfViewer.openPreviewToSide", "alt": "markdownPdfViewer.openPreview",
  "group": "navigation", "when": "resourceLangId == markdown && config.markdownPdfViewer.defaultOpenMode != 'full'" },
{ "command": "markdownPdfViewer.openPreview", "alt": "markdownPdfViewer.openPreviewToSide",
  "group": "navigation", "when": "resourceLangId == markdown && config.markdownPdfViewer.defaultOpenMode == 'full'" }
```
The `openPreview` entry needs an icon too, the same `$(file-pdf)`.

**Keybindings:**

| Key (Windows/Linux) | mac *(unverified)* | Command | when |
|---|---|---|---|
| `ctrl+k shift+p` | `cmd+k shift+p` | openPreviewToSide | `editorLangId == markdown` |
| `ctrl+shift+alt+p` | `cmd+shift+alt+p` | openPreview | `editorLangId == markdown` |
| `ctrl+=`, `ctrl+shift+=`, `ctrl+numpad_add` | `cmd+…` | zoomIn | `activeWebviewPanelId == 'markdownPdfViewer.preview' && markdownPdfViewer.viewerFocused` |
| `ctrl+-`, `ctrl+shift+-`, `ctrl+numpad_subtract` | `cmd+…` | zoomOut | same |
| `ctrl+0`, `ctrl+numpad0` | `cmd+0`, `cmd+numpad0` | zoomReset | same |

*(verify)* Check with a physical ABNT2 keypress that `ctrl+=` shadows `ctrl+oem_plus`. If another layout misses it, add scan-code variants such as `ctrl+[Equal]`.

**Settings:**

| Setting | Type / default | Scope |
|---|---|---|
| `markdownPdfViewer.defaultOpenMode` | `"side"` \| `"full"`, default `"side"` (the title-button action; Alt+click does the other) | application |
| `markdownPdfViewer.pageSize` | `"A4"` \| `"Letter"`, default `"A4"` | application |
| `markdownPdfViewer.pageNumbers` | boolean, default `true` | application |
| `markdownPdfViewer.renderOnSave` | boolean, default `true` | application |
| `markdownPdfViewer.allowRemoteImages` | boolean, default `true` | application |
| `markdownPdfViewer.chromiumPath` | string, default `""` | machine |
| `markdownPdfViewer.chromiumDownload` | `"ask"` \| `"never"`, default `"ask"` | application |

Read the settings with `getConfiguration('markdownPdfViewer')` and **no** resource argument.

### B2. Repository layout
```
package.json  tsconfig.json  esbuild.mjs  vitest.config.ts  .vscodeignore
README.md  CHANGELOG.md  LICENSE  PLAN.md
src/
  extension.ts              activation, command registration, context keys, rename hook
  shared/messages.ts        typed message protocol (imported by host and webview)
  shared/types.ts           Highlight, Selector, StoredRecord, ZoomValue …
  preview/PreviewManager.ts one panel per document, open/toggle/reveal, serializer
  preview/PreviewPanel.ts   webview HTML/CSP, message routing, render scheduling
  converter/index.ts        entry of the lazily loaded converter bundle
  converter/markdown.ts     markdown-it instance + plugins + renderer overrides
  converter/highlight.ts    Shiki highlighter (lazy, languages preloaded per doc)
  converter/mermaid.ts      Mermaid page, render diagrams → SVG, cache by hash
  converter/assets.ts       virtual-origin request handling (read-only)
  converter/chromium.ts     resolve / download / launch / idle-close / crash recovery
  converter/pdf.ts          print page orchestration → Uint8Array + warnings
  converter/print.css       print stylesheet
  anchoring/textModel.ts    build normalized text model from PDF.js text content
  anchoring/quote.ts        selection → TextQuoteSelector + TextPositionSelector
  anchoring/match.ts        exact + fuzzy (approx-string-match) + scoring
  store/HighlightStore.ts   per-file JSON, queueing, migrations
  store/atomicWrite.ts      temp file + fsync + rename (+ retry on Windows EPERM)
  export/annotate.ts        @cantoo/pdf-lib highlight annotations
  export/downloads.ts       Downloads folder detection
  util/log.ts               LogOutputChannel wrapper
webview/
  main.ts  viewer.ts  toolbar.ts  zoom.ts  highlightLayer.ts  highlightList.ts
  popover.ts  links.ts  styles.css  icons/
test/
  unit/store.test.ts  unit/anchoring.test.ts  unit/textModel.test.ts
  converter/convert.test.ts (Node; uses the installed browser)
  fixtures/feature-test.md  fixtures/images/…  fixtures/other.md
dist/   (build output, the only thing packaged)
```
`.vscodeignore` excludes `src/`, `webview/` sources, `test/`, `node_modules/`, `PLAN.md`, `*.map`, and the configs.

### B3. Converter pipeline
1. **Input** is `TextDocument.getText()`, which includes unsaved edits. Nothing is ever written back.
2. **markdown-it**
   - Options: `{ html: true, linkify: true, typographer: false, breaks: false }`, matching VS Code's preview defaults.
   - Plugins, in order:
     - front-matter (hide; keep `title` for PDF metadata)
     - anchor (github-slugger slugs; no permalink symbols)
     - footnote
     - tasklist (disabled checkboxes)
     - emoji
     - `@vscode/markdown-it-katex` (`$…$`, `$$…$$`, `\begin…\end` blocks, like VS Code)
     - alert
   - Fence override:
     - ` ```mermaid ` becomes a placeholder `<div class="mermaid-slot" data-i="n">`.
     - Other fences are highlighted with Shiki (theme `github-light`; preload the languages found in `md.parse()` tokens first; unknown languages fall back to escaped plain text).
3. **URLs**
   - The document is served at `https://md-pdf.invalid/fs/<doc dir path>/<name>.md.__pdf__.html`, so relative URLs resolve against the Markdown file's folder. This works for raw-HTML `<img>` too, with no `<base>`. A `<base>` would break `#anchors`.
   - Absolute file paths (`C:\…`, `/…`, `file:///…`) in Markdown images and raw-HTML `src` attributes are rewritten to `/fs/…`. A leading `/` means the workspace-folder root, like VS Code's preview.
   - Before printing, `page.evaluate` rewrites every `a[href]` that resolves to our origin (except same-document `#fragments`) to an absolute `file:///` URL. For remote windows, map back to the document's URI scheme and authority.
   - `http(s):`, `mailto:` and other schemes are kept.
4. **Print page**
   - `page.setJavaScriptEnabled(false)`. `page.evaluate` still works (verified).
   - `setRequestInterception(true)` with an allow-list:
     - our document URL
     - `/fs/…` → `vscode.workspace.fs.readFile` (images, CSS, fonts referenced by the doc)
     - `/__ext__/…` → extension assets (`print.css`, `katex.min.css` + fonts)
     - remote `http(s)` resources of type image, if `allowRemoteImages`, with a timeout
     - everything else is aborted
   - Every failed request is collected as a warning, for example "image not found: …", and shown with a "Show details" action.
   - After `load`, wait for `document.fonts.ready`. Then run the measurement fixes through `page.evaluate`:
     - mark short `pre` blocks (< ~300 px) as `break-inside: avoid`
     - scale overflowing tables with `zoom` (minimum 0.6; below that keep wrapping)
5. **Mermaid**
   - A separate page with JS enabled and no network. Inject `mermaid.min.js` from `dist/assets`.
   - `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })`, then `mermaid.render(id, code)` for each diagram → SVG string, inlined into the slot.
   - Errors render a red box in the PDF and add a warning.
   - Cache SVGs by `hash(code)`. Auto-dismiss dialogs.
6. **`page.pdf()`** options:
   ```
   { format: A4|Letter, margin: {top:'18mm', bottom:'20mm', left:'16mm', right:'16mm'},
     printBackground: true, tagged: true, outline: true,
     displayHeaderFooter: pageNumbers, headerTemplate: '<div></div>',
     footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#666"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' }
   ```
   This returns a `Uint8Array`. **Never pass `path`.**
7. **`print.css` essentials**
   - System font stack, 11pt, line-height ≈ 1.55, link color `#0969da`.
   - `h1–h6 { break-after: avoid; break-inside: avoid }` and `:is(h1,h2,h3,h4,h5,h6) + * { break-before: avoid }`.
   - `img, svg, figure, .mermaid, .katex-display, tr { break-inside: avoid }`.
   - `img { max-width: 100%; max-height: <content height>; object-fit: contain }`.
   - `pre { white-space: pre-wrap; overflow-wrap: anywhere }`. A PDF can't scroll, so code must wrap.
   - `table { border-collapse: collapse }`, borders `#d0d7de`, `th` background `#f6f8fa`, `thead { display: table-header-group }`, `td { overflow-wrap: anywhere }`. Alignment comes from markdown-it's inline `text-align`.
   - Styles for blockquotes, `hr`, footnotes (smaller), task-list checkboxes, and GitHub alerts.
   - Page background white.
8. **Output** is `{ pdf: Uint8Array, warnings: string[], title }`. Renders are queued per document, and the latest wins: superseded renders are skipped.

### B4. Chromium management (`converter/chromium.ts`)
**Resolution order:**
1. The setting (`chromiumPath`).
2. `computeSystemExecutablePath({ browser: CHROME, channel: STABLE, platform })`.
3. Candidate paths:
   - Windows: `%PROGRAMFILES%`, `%PROGRAMFILES(X86)%` and `%LOCALAPPDATA%`, each combined with:
     - `Google\Chrome\Application\chrome.exe`
     - `Microsoft\Edge\Application\msedge.exe`
     - `Chromium\Application\chrome.exe`
     - `BraveSoftware\Brave-Browser\Application\brave.exe`
   - macOS: `/Applications/{Google Chrome,Microsoft Edge,Chromium,Brave Browser}.app/Contents/MacOS/…`
   - Linux: `google-chrome(-stable)`, `chromium(-browser)`, `/snap/bin/chromium`, `microsoft-edge(-stable)`, `brave-browser` under `/usr/bin`
4. A previously downloaded build in `globalStorage/chromium`.
5. Download, unless `chromiumDownload == "never"`.

**Download:**
- Ask first, with a modal: "Download Chromium (~126 MB)?"
- Resolve the build ID with `resolveBuildId(Browser.CHROMEHEADLESSSHELL, platform, 'stable')`. If that fails, use puppeteer's pinned `chrome-headless-shell` **156.0.8078.47**.
- `install({ browser: CHROMEHEADLESSSHELL, buildId, cacheDir, downloadProgressCallback })` with a `withProgress` notification.
- Remove older builds afterwards.

**Launch:**
```
{ executablePath, headless: isHeadlessShell ? 'shell' : true, pipe: true,
  userDataDir: <globalStorage>/chromium-profile,
  args: ['--no-first-run','--no-default-browser-check','--disable-extensions',
         '--disable-background-networking','--disable-sync','--hide-scrollbars','--mute-audio'] }
```
- Wipe the profile directory on activation and on deactivate.
- Keep the sandbox on. Add `--no-sandbox` only on Linux when running as root.

**Lifecycle:**
- Launch lazily and keep one instance.
- Close it after 120 s idle and on `deactivate`.
- On `disconnected`, relaunch on the next render.

**Error messages** (with actions):
- no browser found → [Download Chromium] [Set Path…] [Learn more]
- download failed or network/proxy problem → [Retry] [Open Proxy Settings]
- launch failed (policy?) → [Use Downloaded Chromium] [Show Log]

### B5. Preview panels and commands (`preview/`)
- **Panel registry:** `Map<uri.toString(), PreviewPanel>`. Opening an existing panel calls `panel.reveal(...)`, which focuses it.
- **Open side:** `createWebviewPanel(viewType, 'PDF: <name>', { viewColumn: ViewColumn.Beside, preserveFocus: false }, options)`.
- **Open full:** the same, with `viewColumn` set to the Markdown editor's column.
- **Panel options:** `{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri/dist/webview, extensionUri/dist/assets] }`.
- **Toggle full view:**
  - Find the Markdown editor's group via `window.tabGroups.all` (a `TabInputText` with the document URI).
  - If the panel is in that group, `panel.reveal(ViewColumn.Beside)`. Otherwise `panel.reveal(mdGroup.viewColumn)`.
  - If the Markdown file isn't open, toggle between `Beside` and the active group.
  - `reveal` moves the panel without reloading it. VS Code closes empty groups by default.
- **Re-render:**
  - On `onDidSaveTextDocument` (debounced 300 ms, if `renderOnSave`), and on the manual refresh button.
  - Use the open document's text, or `workspace.openTextDocument(uri)` if it was closed.
- **Focus context key:**
  - The webview posts `focus` and `blur`, and the host calls `setContext('markdownPdfViewer.viewerFocused', …)`.
  - Also set it to `false` on `onDidChangeViewState` when the panel isn't active, and on dispose.
- **Serializer:** the webview keeps `vscode.setState({ uri, location, zoom })`. `deserializeWebviewPanel` restores the panel and re-renders.
- **Renames:** update the panel registry key and title.

### B6. Viewer (webview)
**Bundle:**
- esbuild with `platform: browser`, `format: esm`, entry `webview/main.ts` → `dist/webview/main.js`.
- Set `globalThis.pdfjsLib` before importing `pdfjs-dist/web/pdf_viewer.mjs`.
- Copy `pdf.worker.min.mjs`, `pdf_viewer.css`, `cmaps/`, `standard_fonts/` and `wasm/` to `dist/webview/pdfjs/`.

**CSP** (nonce scripts; resources via `asWebviewUri`):
```
default-src 'none'; img-src ${cspSource} data: blob:; style-src ${cspSource} 'nonce-…';
font-src ${cspSource} data:; script-src 'nonce-…'; worker-src blob:; connect-src ${cspSource};
```
*(verify)* Confirm whether PDF.js needs `'unsafe-inline'` for styles. PDF.js v6 has **no `isEvalSupported` option any more**, so also confirm there are no CSP violations without `'unsafe-eval'`.

**Worker:**
- Fetch the worker URL, wrap it in a Blob, and create `new Worker(blobUrl, { type: 'module' })`. Then set `GlobalWorkerOptions.workerPort = worker`.
- The webview origin can't construct a worker from the resource origin directly.

**Load:**
- `getDocument({ data: pdfBytes, cMapUrl, cMapPacked: true, standardFontDataUrl, wasmUrl, enableXfa: false })` (option names verified in the v6 typings).
- `PDFViewer({ container, eventBus, linkService, textLayerMode: 1, annotationMode: ENABLE, annotationEditorMode: AnnotationEditorType.NONE, enableDetailCanvas: true })`.

**Zoom:**
- `currentScaleValue` is `'page-width'` by default.
- Dropdown: Fit width, Fit page, Actual size, 50, 75, 100, 125, 150, 200, 300, 400 %.
- Buttons call `increaseScale` / `decreaseScale`, clamped to 0.5–4.0. Reset → `'page-width'`.
- Keyboard: the host command posts `zoom {action}` to the webview.
- Ctrl+wheel and pinch: a non-passive `wheel` listener calls `preventDefault()`, then `updateScale({ drawingDelay: 400, scaleFactor, origin: [clientX, clientY] })`, so zoom happens around the cursor and the view re-renders crisply afterwards.
- On a devicePixelRatio change (`matchMedia('(resolution: Xdppx)')` change event), call `pdfViewer.refresh()`.
- Persist the zoom per file through the `viewChanged` message (debounced 500 ms).

**Resize:** a ResizeObserver on the container re-applies `'page-width'`/`'page-fit'` (debounced 100 ms) and keeps the reading position.

**Re-render position:**
- Before reload, save `{ pageNumber, fraction of page height at viewport top }`.
- After `pagesinit`, restore the scale, then use `scrollPageIntoView({ pageNumber, destArray: [null, {name:'XYZ'}, 0, y, null] })`.

**Links:**
- Internal destinations go through PDFLinkService.
- Clicks on `.annotationLayer a[href]` are intercepted (`preventDefault`) and sent to the host as `openLink`.
- `http(s)` and `mailto` → `env.openExternal`.
- `file:` → `vscode.open`. For `.md` files with a `#fragment`, reveal the heading (bonus).

**Toolbar** (VS Code theme tokens `--vscode-*`; pages stay white):

```
[☰ list] [‹] [page n / N] [›] | [−] [zoom ▾] [+] [reset] | [✎ highlight] [● ● ● ● ●] | [⟳] [⤢ full/side] [⤓ ▾ with/without highlights]
```

- Text selection works whether or not the highlight tool is active. Copy is handled by VS Code's webview copy path.
- Use an inline-SVG or codicon font copied to dist.

### B7. Highlights

**Data model** (`shared/types.ts`):
```json
{
  "id": "b3c1…uuid",
  "color": "yellow",
  "createdAt": "2026-11-06T12:00:00Z",
  "updatedAt": "2026-11-06T12:00:00Z",
  "status": "anchored",
  "target": {
    "selector": [
      { "type": "TextQuoteSelector", "exact": "Highlight target sentence", "prefix": "…32 chars…", "suffix": "…32 chars…" },
      { "type": "TextPositionSelector", "start": 1234, "end": 1259 }
    ],
    "hints": {
      "pages": [ { "pageIndex": 0, "rects": [[51.0, 540.0, 424.5, 553.2]] } ],
      "textModelHash": "sha1-of-normalized-text"
    }
  }
}
```
- `status` is either `"anchored"` or `"orphaned"`.
- `rects` are `[x1, y1, x2, y2]` in **PDF user units** (origin bottom-left), one per line, per page. They are used for instant display and for export.

**Colors:**
- `yellow` (default), `pink`, `green`, `blue`, `orange`.
- Initial hex values are `#FFE45C #FF8AC6 #7BE38B #74C0FC #FFB347`; tune them visually.
- On screen: overlay opacity 0.4 with `mix-blend-mode: multiply`. In the export: `CA 0.4` with BM Multiply.
- The last-used color is stored in `globalState` (global).

**Text model** (`anchoring/textModel.ts`, pure):
- Built from `page.getTextContent()` for every page, mirroring PDF.js `TextLayer` rules so offsets map 1:1 to `textLayer.textDivs` / `textContentItemsStr`:
  - non-empty items become divs
  - `hasEOL` becomes a newline
  - a page boundary becomes a newline
- **Exclude header and footer items.** These are items whose baseline is inside the top or bottom margin band, computed from the known page margins. This drops the page numbers; the spike showed `"1 /"` leaking into page text.
- Normalized string: collapse every whitespace run to a single space. Keep an index map from each normalized index to `{pageIndex, itemIndex, charOffset}`.

**Creation** (only when the highlight tool is active):
1. On `pointerup`, if the selection is non-collapsed and inside text layers, map the DOM range endpoints (span + offset) to item and char offsets, then to normalized `[start, end)`.
2. Build the selector: `exact`, plus `prefix`/`suffix` of 32 normalized characters, plus the position selector.
3. Compute the rects. Clear the selection and render.
4. Post `createHighlight`.

**Rect computation:**
- For each page touched, build a DOM `Range` over that page's text-layer spans.
  - If the page isn't rendered yet, build an off-screen `new TextLayer({ textContentSource, container, viewport })` at scale 1.
- Call `getClientRects()`, drop empty rects, and merge rects on the same line.
- Convert to PDF units with `viewport.convertToPdfPoint`.

**Rendering:**
- Each PDF.js `.page` gets a `.mpv-highlight-layer`, inserted after `.canvasWrapper` and below `.textLayer`, so selection still works.
- Boxes are positioned in **% of the page box**. That keeps them exact at every zoom with no recomputation.
- Rebuild on `pagerendered` and `textlayerrendered`, since pages are virtualized.
- **Clicking a highlight:** on `click` with a collapsed selection, hit-test the point against the rects. A match opens a popover with the 5 swatches and Delete.

**Re-anchoring** (`anchoring/match.ts`, pure). Runs after every load, for every highlight:
1. **Fast path:** the position selector still contains `exact`, and the context matches.
2. **Exact search:** look for every occurrence of `exact`. Score each candidate by prefix and suffix similarity and by distance to the old position. Pick the best.
3. **Fuzzy search:** `search(text, exact, maxErrors)` from approx-string-match, with `maxErrors = min(256, ⌊exact.length/2⌋)`.
   - Score (weights from Hypothesis): `50·quoteScore + 20·prefixScore + 20·suffixScore + 2·posScore`.
   - Accept only if the quote errors are ≤ 20% of the length. Otherwise mark it **orphaned**.
4. For anchored highlights, recompute the rects (off-screen text layers for unrendered pages). Then post `anchorsResolved` with the status, position and rects. The original `exact`/`prefix`/`suffix` are **not** rewritten, to avoid drift.

**Highlights list (sidebar):**
- Entries are in document order: color dot, excerpt of about 80 characters, page number.
- Clicking an entry scrolls to it with `scrollPageIntoView` at the rect's top, then flashes it.
- An "Orphaned" group at the bottom offers Delete and Copy text.

### B8. Storage (`store/`)
- **Location:** `globalStorageUri/highlights/`.
  - Windows default profile: `%APPDATA%\Code\User\globalStorage\local.markdown-pdf-viewer\highlights\`.
  - Other profiles: `…\User\profiles\<id>\globalStorage\…`.
- **Key:** `sha256(normalizedPath)`, where `normalizedPath = path.normalize(uri.fsPath)` for `file:` URIs, lower-cased on Windows and macOS (case-insensitive file systems). Use `uri.toString()` for other schemes.
- **Record:** `{ "schemaVersion": 1, "uri": "file:///…", "fsPath": "C:\\…\\notes.md", "view": { "zoom": "page-width" | 1.5 }, "highlights": [ … ], "updatedAt": "…" }`.
- **Atomic write:**
  1. Write to `<key>.json.tmp-<pid>-<rand>`, then `FileHandle.sync()` and close.
  2. `fs.rename` it over the target. On Windows, retry EPERM/EBUSY up to 5 times with backoff, in case antivirus holds the file.
  3. Writes are serialized through a per-key promise chain. Rapid updates are coalesced (200 ms), and the queue is flushed on `deactivate`.
- **Corrupt files:** if one is ever found on load (unexpected with atomic writes), move it aside as `<key>.corrupt-<ts>.json`, start empty, and warn.
- **Renames:** `onDidRenameFiles`, for each `{oldUri, newUri}`:
  - If it is a file with a record, move the record to the new key and update `uri`/`fsPath`.
  - If it is a folder, scan the records whose `fsPath` starts with the old folder plus a separator, and migrate each.
  - Re-key any open panels.
- **Deleted files:** keep their data, since the user may restore the file. The "Reattach Highlights from Another File…" command lists records whose file no longer exists and merges the chosen one into the current file.

### B9. Download (`export/`)
- **Save dialog:** `showSaveDialog({ defaultUri: <Downloads>/<basename>.pdf, filters: { PDF: ['pdf'] }, saveLabel: 'Download PDF' })`.
- **Downloads folder:**
  - Windows: read `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders` value `{374DE290-123F-4565-9164-39C4925E467B}` with `reg query`, expand `%USERPROFILE%`, and fall back to `%USERPROFILE%\Downloads`.
  - macOS: `~/Downloads`.
  - Linux: `xdg-user-dir DOWNLOAD`, then `~/Downloads`, then home.
- **Bytes:** use the PDF currently shown. If the document changed since that render, re-render first.
- **With highlights** (default): use `@cantoo/pdf-lib` (the approach was verified in the spike). For each anchored highlight, for each page, add one `/Annot` dictionary:
  ```
  /Subtype /Highlight  /Rect [union bbox]  /QuadPoints [x1 y2 x2 y2 x1 y1 x2 y1 …per line]
  /C [r g b]  /CA 0.4  /F 4  /T (Markdown PDF Viewer)  /Contents (quote)  /NM (id)  /M (date)
  /AP << /N formXObject(BBox, ExtGState{/BM /Multiply /ca 0.4}, "r g b rg x y w h re f" …) >>
  ```
  - Append it to the page's `/Annots`, creating the array if it is missing. Then `save()`.
  - Orphaned highlights are skipped, and the user is told how many.
- **Without highlights:** write the Chromium buffer unchanged.
- **Write:** `vscode.workspace.fs.writeFile(target)`. This is the **only** PDF that is ever written, and only at the path the user chose.

### B10. Errors, logging, safety
- One `LogOutputChannel`, named "Markdown PDF Viewer". Every user-facing error offers a "Show Log" action.
- The webview shows render errors and warnings in a dismissible banner.
- **Write guard:** all file writes go through `store/atomicWrite.ts` (globalStorage) or `export/` (the user-chosen path).
  - Add a unit test that greps `src/` for any other `writeFile`/`fs.write*`/`workspace.fs.writeFile`/`rename`/`mkdir`.
  - **Markdown files are never written.**
- Content is untrusted:
  - The print page runs with JS off.
  - Mermaid runs in a strict, isolated page with no network.
  - Request interception uses an allow-list.
  - JS dialogs are auto-dismissed.
  - Timeouts: `goto` 30 s, remote image 10 s.

### B11. Build, package, install
`package.json` scripts:
- `build` (esbuild → `dist/extension.js` CJS, `dist/converter.js` CJS lazy, `dist/webview/main.js` ESM, plus asset copies)
- `watch`
- `test` (vitest)
- `test:converter`
- `package` (`vsce package`)

Assets copied to `dist/`:
- the pdf.js worker, CSS, cmaps, standard_fonts and wasm
- `mermaid/dist/mermaid.min.js`
- `katex/dist/katex.min.css` and fonts
- `print.css`
- icons

The exact commands go in the README at M4. The expected form:
```powershell
npm install
npm run build
npx @vscode/vsce package
code --install-extension markdown-pdf-viewer-0.1.0.vsix --force
```

### B12. First steps for M1
1. Run `git init`. Create `package.json` with the manifest from B1, plus `tsconfig.json`, `esbuild.mjs` (three bundles plus asset copy), `vitest.config.ts`, and `.vscodeignore`.
2. Install the pinned dependencies from A1.
3. Implement `converter/chromium.ts` (resolver plus launch) and `converter/pdf.ts` with the virtual origin and interception.
4. Implement `converter/markdown.ts` with all plugins, then Shiki and Mermaid.
5. Write `test/fixtures/feature-test.md`, covering every item in Feature 3, plus images: relative PNG and SVG, an absolute path, a remote URL, and a deliberately missing one. Add `fixtures/other.md` for the relative `.md` link.
6. Add a Node script or test that renders the fixture with the installed browser, saves page PNGs in a temp folder via pdf.js (like the Phase 1 `render.mjs`), and asserts the links and text. Review every page image visually.

---

## Part C — Verification

### C1. Unit tests (vitest)
- **Store:** atomic write (simulated crash leaves the old file intact), concurrent writes are serialized, corrupt-file handling, key normalization (Windows case-insensitivity), file and folder rename migration, zoom persisted alongside highlights.
- **Anchoring:**
  - exact match
  - duplicates resolved by prefix, suffix and position
  - insertions and deletions before or inside the quote
  - whitespace and line-reflow changes
  - quote spanning a page break
  - footer text exclusion
  - orphan threshold
  - long quotes

### C2. Converter checks (Node, installed browser)
Use pdf.js in Node to check:
- link annotations exist: a named `dest` for `#anchors`, a `url` for external links, `file:///` for `.md` links
- every fixture section's text is present: table cells, footnotes, math, Mermaid labels
- the fixture's `<script>` did not run
- the page size matches A4 or Letter
- a warning is reported for the missing image

### C3. UI harness (CDP)
This is the same approach as the Phase 1 zoom test.
1. Spawn `Code.exe` directly with:
   - `--remote-debugging-port=<port>`
   - an isolated `--user-data-dir` and `--extensions-dir`
   - `--extensionDevelopmentPath=<repo>`, or the installed `.vsix`
   - `--disable-workspace-trust --skip-welcome --skip-release-notes`
   - a test workspace folder that is itself a git repo, so `git status` can be checked
2. Connect with `puppeteer.connect({ browserURL, defaultViewport: null })` and find the workbench page (URL contains `workbench`).
3. Find the webview content frame by evaluating a marker in `page.frames()`.
4. Inject trusted input with `page.keyboard` and `page.mouse`. Measure window zoom with the workbench `window.devicePixelRatio`.

Gotchas:
- Unset `ELECTRON_RUN_AS_NODE`.
- puppeteer-core 25 is ESM, so import it by file path from a deps folder.
- Kill the process tree afterwards with `taskkill /PID <pid> /T /F`.
- Synthetic `dispatchEvent` keys are ignored by VS Code.

### C4. Acceptance checklist mapping
| Checklist item (Appendix A) | How it is checked |
|---|---|
| Button only on Markdown; Alt+click opens full width | Harness: inspect `editor/title` actions for `.md` versus `.ts`; click with Alt held |
| Full width, side by side, and toggle | Harness: open both ways, toggle, compare group counts and panel columns |
| Feature file converts with working links, tables, images, code, math, Mermaid | C2, plus visual review of page PNGs |
| Ctrl+= / Ctrl+- / Ctrl+0 zoom the PDF when focused, the window otherwise | Harness: the Phase 1 scenario set against the real extension |
| Sharp text and aligned highlights at 50/100/300 % | Harness screenshots, plus a numeric check of highlight boxes against text-span rects |
| `git status` clean | Harness workspace is a git repo; run `git status --porcelain` after every feature |
| 5 colors and zoom persist after quit and reopen | Harness: create, kill VS Code, relaunch with the same user-data-dir, compare |
| Highlights survive edits and follow renames | Harness: edit the doc, rename via `workspace.fs.rename` or the Explorer, re-check |
| Downloaded PDF has highlights and working links in an external reader | pdf.js check in Node, plus opening it in Edge (and Acrobat or SumatraPDF if available) |
| `.vsix` works in a fresh window with a different folder | `code --install-extension …` into the real VS Code, after asking, or done by the user |

### C5. Manual checks for the user
- Physical keypresses of Ctrl+= / Ctrl+- / Ctrl+0 on the ABNT2 keyboard.
- Trackpad pinch.
- Open the downloaded PDF in your usual reader.
- Install the final `.vsix` in your normal VS Code.

### C6. Phase 1 evidence and scratch scripts (temporary)
These live in this session's scratchpad and are not part of the repo. Rebuild them from C3 if they're gone.
```
C:\Users\Arthur\AppData\Local\Temp\claude\0899fc561e192fd0\80eb3c65-600f-44f5-a17b-61b0d8baf986\scratchpad\
  zoomtest\driver.mjs            CDP driver (20 scenarios) + default-keybinding conflict check
  zoomtest\ext\                  throwaway test extension (webview event recorder)
  zoomtest\out\results.json      raw zoom results; default-keybindings.jsonc (VS Code 1.144.1 dump)
  spike\spike.mjs                Edge → in-memory PDF via virtual origin + pdf-lib highlight
  spike\render.mjs               pdf.js page → PNG
  spike\out\spike-with-highlight.pdf, page1.png
  deps\node_modules\             puppeteer-core 25.16.0, pdfjs-dist 6.5.438, @cantoo/pdf-lib 2.11.1, esbuild 0.28.2
  repos\                         yzane/vscode-markdown-pdf @37bee5a, simonhaenisch/md-to-pdf @8fe2711
```
Spike facts:
- The PDF is a `Uint8Array` (46 KB, 2 pages).
- Link annotations: dest `"second-section"`, url `https://example.com/docs`, url `file:///C:/Users/Arthur/notes/other.md#intro`, dest `"top"`.
- An outline is present.
- The missing image was reported as `ENOENT`, and the `<script>` did not run.
- After pdf-lib, pdf.js reports `subtype: "Highlight"`, color `[255,235,59]`, 8 quad points, and the links and outline are intact.

---

## Appendix A — Original task specification (verbatim)

*Headings are shifted two levels so they nest under this appendix. The text is otherwise unchanged.*

### Task: Build a VS Code extension, "Markdown PDF Viewer with Highlights"

#### Goal
Build a VS Code extension that renders the active Markdown file as a PDF inside a dedicated VS Code panel. The user can highlight text in the PDF with multiple colors, zoom freely, and read in full-panel mode. Highlights persist permanently per file. The user can download the PDF. The extension must never modify Markdown files and must never create files in the user's workspace or repository.

#### Phase 1: Research first, then propose a plan (do this before writing code)
Mature tools already exist for most of this. Do not reinvent them. Look into the current state of these tools, check that they are actively maintained, and compare them:

- **Markdown → HTML:** markdown-it and its plugin ecosystem (anchors, footnotes, task lists, emoji, KaTeX math, front matter); VS Code's built-in Markdown preview pipeline; marked.
- **HTML → PDF:** headless Chromium via puppeteer-core (Chromium's print-to-PDF keeps clickable links and produces high-quality output); existing projects such as the `markdown-pdf` VS Code extension (yzane) and the `md-to-pdf` npm package. Study how they solve this, and reuse or fork their approach where it makes sense.
- **PDF viewing inside a webview:** Mozilla PDF.js (pdfjs-dist), including its text layer and annotation layer.
- **Writing highlights into the exported PDF:** pdf-lib, or PDF.js's own annotation editor if it supports highlight annotations well enough.

Then give me a short written plan covering:
- the libraries you chose and why
- how Chromium will be obtained (prefer detecting an installed Chrome/Edge/Chromium, with a fallback to downloading one into the extension's global storage, not the workspace)
- the architecture
- the results of the keyboard-zoom check described in Feature 2
- any risks

Wait for my approval before implementing.

#### Hard constraints
1. **Markdown files are read-only to the extension.** Never write to, reformat, or touch them.
2. **No files are created in the workspace or repo.** Generate the PDF in memory (a Buffer) and send it straight to the webview. If temp files are unavoidable for Chromium, put them only in the OS temp directory or `context.globalStorageUri`, and clean them up.
3. **The extension works globally** in all workspaces and windows. It must not depend on workspace settings.
4. **Local installation:** package it as a `.vsix` with `@vscode/vsce` and give me the exact commands to build and install it (`code --install-extension ...`). No Marketplace publishing.

#### Feature 1: Open the PDF view
- Add a button to the editor title bar (top-right) using `contributes.menus` → `editor/title`. It should only appear when `resourceLangId == markdown`.
- Clicking the button converts the current Markdown file and opens a webview panel showing the PDF in a PDF.js-based viewer. The viewer needs page navigation, scrolling, and text selection.
- Support both ways of opening the viewer, the same way VS Code's built-in Markdown preview does:
  - **"Open PDF Preview to the Side"** opens a split view next to the Markdown editor.
  - **"Open PDF Preview"** opens in the current editor group, so the PDF takes the whole editor area for comfortable reading, like the built-in preview with `Ctrl+Shift+V`.
- Register both as Command Palette commands with keybindings. Suggested defaults are `Ctrl+K P` for the side view and `Ctrl+Shift+Alt+P` for the full view. Check both against VS Code's default keybindings, and pick alternatives if either conflicts.
- The title-bar button opens to the side by default. Alt+click opens it full-width, same as VS Code's own preview button. Add a setting to choose the default.
- Add a "toggle full view" button in the viewer toolbar. It moves the panel between split and full-width modes.
- The viewer must work correctly with VS Code's native "Maximize Editor Group" and Zen Mode.
- The PDF must fill the available panel space and reflow when the panel resizes. Use fit-to-width by default.
- When the Markdown file is saved, re-render the PDF automatically. Preserve scroll position where possible, and add a manual refresh button as well.
- Only one panel per Markdown file. Re-clicking the button focuses the existing panel.

#### Feature 2: Zoom
- Toolbar controls: zoom in, zoom out, a zoom-level dropdown (50%–400%, fit width, fit page, actual size), and reset.
- Ctrl+mouse wheel and trackpad pinch zoom the PDF.
- **Keyboard zoom (verify before implementing):** in VS Code, `Ctrl+=` / `Ctrl+-` / `Ctrl+0` normally zoom the whole window UI (`workbench.action.zoomIn` / `zoomOut` / `zoomReset`). Test what happens today when a webview has focus, and report the result in the plan. Desired behavior:
  - When the PDF panel is focused, `Ctrl+=` / `Ctrl+-` / `Ctrl+0` zoom the PDF itself, re-rendered crisply by PDF.js, not a blurry scaled bitmap. Implement this with contributed keybindings scoped by a `when` clause such as `activeWebviewPanelId == '<viewType>'`, or by handling the keys inside the webview. Use whichever proves reliable.
  - When focus is anywhere else, VS Code's normal window zoom works unchanged.
  - If the whole VS Code window is zoomed, the PDF must re-render sharply, so handle `devicePixelRatio` changes.
- Remember the zoom level per file across sessions, stored alongside the highlights.

#### Feature 3: Conversion quality (this must be excellent)
The PDF must faithfully preserve everything in the Markdown:
- **Links:** external links are clickable and open in the system browser via `vscode.env.openExternal`. Internal heading anchors (`#section`) jump to the right place in the PDF. Relative links to other `.md` files open that file in VS Code.
- **Tables:** with alignment and proper borders. Wide tables are handled sensibly.
- **Images:** relative paths resolved against the Markdown file's directory, plus absolute paths, remote URLs, and SVG. Embed them so the exported PDF is self-contained.
- **Code blocks** with syntax highlighting.
- **The rest:** headings, nested lists, task lists, blockquotes, footnotes, horizontal rules, inline HTML, emoji, KaTeX/LaTeX math, Mermaid diagrams. Front matter should be hidden.
- Clean, readable print styling: sensible margins, page breaks that avoid splitting headings from their content or cutting images in half, and A4/Letter page size configurable in settings.
- Make a test Markdown file that exercises every feature above. Use it to verify the output visually. Keep it in the extension's own source folder, never in the user's workspace.

#### Feature 4: Highlighting
- Add a highlight tool to the viewer toolbar. When it's active, selecting text creates a highlight.
- Colors: **yellow (default)**, pink, green, blue, orange. Show a color picker in the toolbar. The last-used color is remembered.
- Clicking an existing highlight lets the user change its color or delete it.
- Add a sidebar or dropdown that lists all highlights for the file. Clicking one jumps to it.
- Highlights must render precisely over the PDF.js text layer. They must stay perfectly aligned at every zoom level, after window resizes, and when switching between split and full view.

#### Feature 5: Permanent per-file persistence
- Highlights must survive closing VS Code and rebooting the computer. Store them in `context.globalStorageUri`, as one JSON file per Markdown file, keyed by a hash of the file's absolute path. Never store them in the workspace.
- **Anchoring must survive edits to the Markdown.** Store each highlight using a text-quote selector: the exact text plus some prefix and suffix context, following the W3C Web Annotation model. Also store page and position as hints. Do not store only coordinates. After re-rendering, re-anchor each highlight by searching for its text. Highlights that can no longer be found should be marked as "orphaned" and shown in the list, not silently deleted.
- Handle file renames and moves with `vscode.workspace.onDidRenameFiles` by migrating the stored highlights and zoom level to the new path.
- Write saves atomically, so a crash never corrupts the stored data.

#### Feature 6: Download
- Add a Download button that opens `vscode.window.showSaveDialog`. The default location is the user's Downloads folder, and the default filename is `<markdown-name>.pdf`. This is the only time a PDF is written to disk, and only where the user chooses.
- By default, include the highlights in the downloaded PDF as real PDF highlight annotations, so they appear in any PDF reader. Also offer a "Download without highlights" option.
- Links must remain clickable in the downloaded file.

#### Engineering requirements
- TypeScript, bundled with esbuild. Webview with a strict Content Security Policy, and resources loaded through `asWebviewUri`.
- Clear separation of concerns: converter, viewer webview, highlight store, and extension activation and commands.
- The viewer UI must look right in both light and dark VS Code themes. The PDF pages themselves stay white.
- Show helpful error messages, for example when Chromium is missing or an image fails to load.
- Write unit tests for the highlight store and the re-anchoring logic.
- Write a README covering installation, usage, keybindings, settings, where highlight data is stored, and how to back it up or reset it.

#### Acceptance checklist
- [ ] The button appears only on Markdown files, top-right. Alt+click opens full-width.
- [ ] The PDF can open full-width in the current editor group and side-by-side, and toggle between the two.
- [ ] The feature test file converts with working links, tables, images, code, math, and Mermaid.
- [ ] Ctrl+= / Ctrl+- / Ctrl+0 zoom the PDF when the panel is focused, and zoom the VS Code window normally otherwise.
- [ ] Text stays sharp and highlights stay aligned at 50%, 100%, and 300% zoom.
- [ ] `git status` in the workspace shows no changes after using every feature.
- [ ] Highlights in all 5 colors, and the zoom level, persist after fully quitting and reopening VS Code.
- [ ] Highlights survive small edits to the Markdown and follow the file when it's renamed.
- [ ] The downloaded PDF opens in an external reader with highlights and working links.
- [ ] Installed from `.vsix` and working in a fresh VS Code window with a different folder.
