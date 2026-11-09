# Markdown PDF Viewer with Highlights

Render the Markdown file you are editing as a **real PDF** inside VS Code, read it side by side or full width, **highlight** text in five colors, zoom freely, switch the pages to a **dark theme**, and **download** the PDF with your highlights as standard PDF annotations.

- The PDF is produced by Chromium's print-to-PDF, so links stay clickable, headings become an outline, and the layout matches what you would print.
- Highlights are stored per file outside your workspace and survive restarts, edits to the Markdown, and file renames.
- **The extension never writes to your Markdown files and never creates files in your workspace.** The only file it ever writes is the PDF you download, at the location you choose.

## Contents

- [Install](#install)
- [Requirements](#requirements)
- [Using it](#using-it)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings](#settings)
- [Where highlights are stored (backup and reset)](#where-highlights-are-stored-backup-and-reset)
- [What gets converted](#what-gets-converted)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Known limitations](#known-limitations)

## Install

The extension is installed locally from a `.vsix` file; it is not on the Marketplace.

From the project folder (PowerShell, Command Prompt or a POSIX shell; Node.js 22 or newer):

```bash
npm install
```

```bash
npm run build
```

```bash
npx @vscode/vsce package --allow-missing-repository
```

```bash
code --install-extension markdown-pdf-viewer-0.1.0.vsix --force
```

`npm run package` runs the same `vsce package` command. Then reload VS Code (**Developer: Reload Window**) or open a new window.

To uninstall: `code --uninstall-extension local.markdown-pdf-viewer`. Uninstalling keeps your stored highlights (see [Where highlights are stored](#where-highlights-are-stored-backup-and-reset)).

## Requirements

- VS Code 1.110 or newer.
- A Chromium-based browser to produce PDFs. The extension uses, in this order:
  1. the browser set in **`markdownPdfViewer.chromiumPath`**,
  2. an installed **Google Chrome**, **Microsoft Edge**, **Chromium** or **Brave**,
  3. a Chromium previously downloaded by the extension.

  If none is found, the extension asks before downloading *chrome-headless-shell* (about 126 MB) into VS Code's global storage folder (never into your workspace). Set `markdownPdfViewer.chromiumDownload` to `never` to forbid that.

The browser runs headless, with JavaScript disabled for your document and no network access except remote images (which you can turn off). Its temporary profile lives in the OS temp folder and is deleted when the browser closes; the browser itself is closed after two idle minutes.

## Using it

### Open the PDF

| How | Opens |
|---|---|
| The **PDF button** in the editor title bar of a Markdown file (top right) | To the side of the editor |
| **Alt+click** on the same button | In the current editor group, full width (like `Ctrl+Shift+V`) |
| **Markdown PDF: Open PDF Preview to the Side** (`Ctrl+K Shift+P`) | To the side |
| **Markdown PDF: Open PDF Preview** (`Ctrl+Shift+Alt+P`) | In the current group |
| Explorer context menu → **Open PDF Preview to the Side** | To the side |

The setting `markdownPdfViewer.defaultOpenMode` swaps what a plain click and Alt+click do. Each Markdown file has at most one PDF preview; opening it again focuses the existing one.

The PDF re-renders automatically when you **save** the Markdown (it keeps your reading position), or when you press **Refresh** in the toolbar. Unsaved changes are included when you refresh manually.

### The toolbar

| Control | What it does |
|---|---|
| ☰ | Show or hide the list of highlights |
| ↑ ↓, page box | Previous/next page, go to a page |
| − / zoom list / + / ↺ | Zoom out, choose a zoom (Fit Width, Fit Page, Actual Size, 50 %–400 %), zoom in, reset to Fit Width |
| ✎ | **Highlight tool**: while it is on, every text selection becomes a highlight |
| ● ● ● ● ● | Highlight color: yellow (default), pink, green, blue, orange. The last color you used is remembered |
| ◐ | **Light/dark pages**: re-renders the PDF with a dark page theme for night reading (remembered for all files). Downloads always use the normal light pages |
| ⟳ | Refresh |
| ⤢ | **Full view**: move the PDF between "next to the Markdown" and "in the Markdown's editor group". Works with **View: Toggle Maximized Editor Group** and **Zen Mode** |
| ⤓ ▾ | Download the PDF, with highlights (default) or without |

Zoom also works with **Ctrl + mouse wheel** and **trackpad pinch**. Pages are re-rendered sharply at every zoom level and when the VS Code window zoom or the monitor's scale changes.

### Highlighting

- **Highlight tool on**: select text; it is highlighted in the current color.
- **Highlight tool off**: select text; a small color bar appears next to the selection; pick a color. You can also select text and click a color in the toolbar.
- **Click a highlight** to change its color, copy its text, or delete it.
- The **☰ list** shows all highlights in document order with their page; click one to jump to it.

Highlights are attached to the *text*, not to a position on the page: each one stores the highlighted words plus some text before and after (a W3C Web Annotation *TextQuoteSelector*), and the page/position as hints. After every re-render the extension searches for each highlight again, so it follows the text when you edit the Markdown. If the text was rewritten so much that it can no longer be found, the highlight is kept and listed under **Orphaned** in the list, where you can copy its text or delete it.

### Download

**Download** opens a save dialog in your Downloads folder with `<markdown name>.pdf` as the name. With highlights (the default), each highlight is written as a real PDF highlight annotation (color, 40 % opacity, the highlighted text as its comment), so it shows up in Acrobat, Edge, Chrome, Firefox, SumatraPDF, Preview and other readers. Links stay clickable. **Download without highlights** saves the plain PDF.

## Keyboard shortcuts

| Shortcut | Command | When |
|---|---|---|
| `Ctrl+K Shift+P` (macOS `Cmd+K Shift+P`) | Open PDF Preview to the Side | A Markdown editor is focused |
| `Ctrl+Shift+Alt+P` (macOS `Cmd+Shift+Alt+P`) | Open PDF Preview (current group) | A Markdown editor is focused |
| `Ctrl+=`, `Ctrl+Shift+=`, `Ctrl+Numpad+` | Zoom in (PDF) | The PDF viewer is focused |
| `Ctrl+-`, `Ctrl+Shift+-`, `Ctrl+Numpad-` | Zoom out (PDF) | The PDF viewer is focused |
| `Ctrl+0`, `Ctrl+Numpad0` | Reset zoom to Fit Width (PDF) | The PDF viewer is focused |
| `Ctrl+Wheel`, pinch | Zoom around the pointer | Pointer over the PDF |

When focus is anywhere else, `Ctrl+=`/`Ctrl+-`/`Ctrl+Numpad0` keep zooming the whole VS Code window as usual (`Ctrl+0` is VS Code's "Focus Primary Side Bar" there).

`Ctrl+K P` (the shortcut you might expect) is already VS Code's **Copy Path of Active File**, so the side preview uses `Ctrl+K Shift+P`. All shortcuts can be changed in **Preferences: Open Keyboard Shortcuts** (search for "Markdown PDF").

All commands are in the Command Palette under **Markdown PDF:**, including *Toggle Light/Dark Pages*, *Toggle Highlight Tool*, *Toggle Highlights List*, *Reattach Highlights from Another File…*, *Delete All Highlights for This File*, *Reveal Highlight Data Folder* and *Show Log*.

## Settings

All settings are user/machine settings: workspace settings cannot change them, so the extension behaves the same in every workspace and window.

| Setting | Default | Description |
|---|---|---|
| `markdownPdfViewer.defaultOpenMode` | `side` | What a plain click on the title-bar button does: `side` or `full` (Alt+click does the other) |
| `markdownPdfViewer.pageSize` | `A4` | `A4` or `Letter` |
| `markdownPdfViewer.pageNumbers` | `true` | Print "n / N" at the bottom of each page |
| `markdownPdfViewer.renderOnSave` | `true` | Re-render when the Markdown file is saved |
| `markdownPdfViewer.allowRemoteImages` | `true` | Download `http(s)` images and embed them in the PDF |
| `markdownPdfViewer.chromiumPath` | *(empty)* | Path to a Chrome/Edge/Chromium executable; empty means detect automatically |
| `markdownPdfViewer.chromiumDownload` | `ask` | `ask`: offer to download Chromium when none is found; `never`: show an error instead |

## Where highlights are stored (backup and reset)

Highlights and the zoom level of each file are stored in VS Code's **global storage** for this extension, one JSON file per Markdown file, named after a SHA-256 hash of the file's absolute path:

| OS | Folder (default profile) |
|---|---|
| Windows | `%APPDATA%\Code\User\globalStorage\local.markdown-pdf-viewer\highlights\` |
| macOS | `~/Library/Application Support/Code/User/globalStorage/local.markdown-pdf-viewer/highlights/` |
| Linux | `~/.config/Code/User/globalStorage/local.markdown-pdf-viewer/highlights/` |

With a non-default VS Code profile the folder is under `User/profiles/<profile id>/globalStorage/…`; **Markdown PDF: Reveal Highlight Data Folder** opens the right one. Insiders builds use `Code - Insiders` instead of `Code`.

Each file looks like this (shortened):

```json
{
 "schemaVersion": 1,
 "uri": "file:///c%3A/Users/me/notes/lecture.md",
 "fsPath": "c:\\Users\\me\\notes\\lecture.md",
 "view": { "zoom": 1.5 },
 "highlights": [
  {
   "id": "5ee69a55-…", "color": "yellow", "status": "anchored",
   "target": {
    "selector": [
     { "type": "TextQuoteSelector", "exact": "quick brown fox", "prefix": "…The ", "suffix": " jumps over…" },
     { "type": "TextPositionSelector", "start": 41, "end": 56 }
    ],
    "hints": { "pages": [{ "pageIndex": 0, "rects": [[72.4, 701.2, 165.9, 714.6]] }] }
   }
  }
 ]
}
```

- **Back up**: copy the `highlights` folder. To restore, copy the files back while VS Code is closed.
- **Reset one file**: run **Markdown PDF: Delete All Highlights for This File** from its preview, or delete its JSON file.
- **Reset everything**: delete the `highlights` folder.
- Files are written atomically (temporary file + flush + rename), so a crash never leaves a half-written file. If a file is ever unreadable, it is renamed to `….corrupt-<time>.json` and you get a warning.
- **Renames**: when you rename or move a Markdown file (or a folder) inside VS Code, its highlights follow it. If you renamed it outside VS Code (File Explorer, `git mv`), open the preview of the new file and run **Markdown PDF: Reattach Highlights from Another File…**, then pick the old entry (files that no longer exist are listed first). Data of deleted files is kept, so you can reattach it later.
- Global storage is per VS Code profile, so highlights made in one profile are not visible in another.

## What gets converted

Everything the feature test file (`test/fixtures/feature-test.md` in the source) exercises:

- Headings (with GitHub-style anchors and a PDF outline), paragraphs, emphasis, strikethrough, inline code, hard line breaks.
- **Links**: external links open in your browser; `#heading` links jump within the PDF; relative links to other `.md` files open that file in VS Code (and point to `file:///…` in the downloaded PDF).
- **Tables** with column alignment and borders; wide tables are scaled down to fit (and wrapped if needed); long tables repeat their header row on every page.
- **Images**: relative paths, absolute paths (`C:\…`, `file:///…`), workspace-root paths (`/images/x.png`, as in VS Code's preview), remote `http(s)` images and SVG. Everything is embedded, so the PDF is self-contained. Missing images produce a visible placeholder and a warning.
- **Code blocks** with syntax highlighting from VS Code's own TextMate grammars (Shiki); long lines wrap.
- Nested lists, task lists, blockquotes, GitHub alerts (`> [!NOTE]` …), footnotes, horizontal rules, inline HTML (`<kbd>`, `<sub>`, `<sup>`, `<mark>`, `<details>`, …), emoji shortcodes, **KaTeX** math (`$…$`, `$$…$$`, `\begin{align}…`, ```` ```math ````) and **Mermaid** diagrams. Front matter is hidden (its `title` becomes the PDF title).
- Print styling: 18/20/16 mm margins, A4 or Letter, page numbers, headings kept with their content, images/diagrams/short code blocks/table rows never split, very tall images scaled to fit a page.

## Troubleshooting

- **"needs Chrome, Edge or Chromium"**: install one of them, choose a browser executable when asked, or let the extension download Chromium.
- **The browser cannot start** (some company policies block headless browsers): choose **Download Chromium** in the error message, or point `markdownPdfViewer.chromiumPath` at another browser.
- **Downloading Chromium fails behind a proxy**: check VS Code's `http.proxy` settings, then retry.
- **An image is missing**: the yellow banner in the viewer and **Markdown PDF: Show Log** list every image or resource that could not be loaded.
- Anything else: **Markdown PDF: Show Log** (log level can be raised with **Developer: Set Log Level…**).

## Development

```bash
npm install
```

```bash
npm run build
```

| Script | Purpose |
|---|---|
| `npm run build` / `npm run watch` | Bundles `dist/extension.js` (CommonJS), `dist/converter/` (lazy-loaded ESM) and `dist/webview/`, and copies assets |
| `npm test` | Unit tests (highlight store, anchoring, text model, write guard) |
| `npm run test:converter` | Renders the feature test with the installed browser and checks the PDF with pdf.js |
| `npm run typecheck` | TypeScript type check |
| `npm run package` | Builds the `.vsix` |

`node test/converter/render-fixture.mjs [file.md] [--theme dark] [--size Letter]` writes a PDF and one PNG per page to the OS temp folder for visual review.

Layout: `src/converter/` (Markdown → HTML → PDF; no `vscode` dependency), `src/preview/` (panels, commands, rendering, downloads), `src/store/` (highlight storage), `src/anchoring/` (text model and quote matching, shared with the viewer), `src/export/` (PDF annotations, Downloads folder), `webview/` (the PDF.js-based viewer). `PLAN.md` has the full design.

## Known limitations

- Highlight edges follow PDF.js's text layer, which approximates glyph positions; on long lines an edge can be off by a fraction of a character.
- Renames done outside VS Code are not detected automatically (use *Reattach Highlights*).
- Highlights are per VS Code profile.
- Emoji depend on the system's emoji font (built in on Windows and macOS; install Noto Color Emoji on Linux).
- `file:///` links in a downloaded PDF point to absolute paths on your machine, so they only work there.
