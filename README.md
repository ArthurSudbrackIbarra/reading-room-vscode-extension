# Document Viewer & Highlighter

**A quiet reading room inside VS Code.** Open Markdown, plain text and PDF files as real PDFs, highlight what matters, write notes next to it, mark where you stopped, and read to the sound of rain or a crackling fireplace.

![A Markdown file next to its PDF in the viewer: highlights in four colors, two notes, the red reading marker and the list of highlights](docs/demo.png)

## Features

**Read anything as a PDF**
- **PDF files** open directly in the viewer, exactly as they are, including password-protected ones.
- **Markdown and `.txt` files** become real, print-quality PDFs (Chromium print-to-PDF): clickable links, an outline, syntax-highlighted code, math and diagrams. Converted PDFs are cached, so reopening an unchanged file is instant.
- Zoom freely (toolbar, `Ctrl`+wheel, pinch) and switch the pages to a **dark theme**.

**Highlight and annotate**
- Highlight text in **five colors** and write a **note** on any highlight.
- Highlights hold on to the text itself, so they follow your edits to Markdown and text files.
- A side list shows every highlight and note; click one to jump to it.
- **Undo and redo** all of it with `Ctrl+Z` / `Ctrl+Y`.

**Keep your place**
- Mark **where you stopped reading**. The document opens right there next time.

**Stay focused**
- **Reading sounds**: rain or a fireplace that loop seamlessly for as long as you read, with play/pause and volume in a small panel that disappears when you click away.

**Take it with you**
- **Download** the PDF with your highlights and notes as standard PDF annotations, which Acrobat, Edge, Chrome, Firefox and Preview all show.

**Leaves your files alone**
- Highlights, notes and reading positions are stored per file **outside your workspace**, and survive restarts, edits and renames.
- **The extension never writes to your documents and never creates files in your workspace.** The only file it writes outside its own storage folder is a PDF you download, where you choose.

## Contents

- [Install](#install)
- [Requirements](#requirements)
- [Using it](#using-it): opening documents, highlights, notes, the reading marker, [reading sounds](#reading-sounds), undo, download
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings](#settings)
- [Where your data is stored (backup and reset)](#where-your-data-is-stored-backup-and-reset)
- [What gets converted](#what-gets-converted)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Known limitations](#known-limitations)
- [Credits](#credits)

## Install

The extension is installed from a `.vsix` file that you build yourself; it is not on the Marketplace. You need Node.js 22 or newer. From the project folder:

1. Install the dependencies:

   ```bash
   npm install
   ```

2. *(Optional)* Make the reading sounds. This step needs [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org/) on your `PATH`; [Reading sounds](#reading-sounds) explains why the audio is not in the repository. Skip it and everything else works the same, without the 🎧 button.

   ```bash
   npm run sounds
   ```

3. Build the package:

   ```bash
   npm run package
   ```

4. Install it:

   ```bash
   code --install-extension markdown-pdf-viewer-0.3.0.vsix --force
   ```

Then reload VS Code (**Developer: Reload Window**) or open a new window. Installing a newer `.vsix` replaces the previous version and keeps your highlights. The extension ID is still `local.markdown-pdf-viewer`, from the days it only handled Markdown.

To uninstall, run `code --uninstall-extension local.markdown-pdf-viewer`. Uninstalling keeps your stored highlights (see [Where your data is stored](#where-your-data-is-stored-backup-and-reset)).

## Requirements

- VS Code 1.110 or newer.
- For **Markdown and text files only**: a Chromium-based browser to produce the PDF. PDF files need nothing else. The extension uses, in this order:
  1. the browser set in **`markdownPdfViewer.chromiumPath`**,
  2. an installed **Google Chrome**, **Microsoft Edge**, **Chromium** or **Brave**,
  3. a Chromium previously downloaded by the extension.

  If none is found, the extension asks before downloading *chrome-headless-shell* (about 126 MB) into VS Code's global storage folder (never into your workspace). Set `markdownPdfViewer.chromiumDownload` to `never` to forbid that.

The browser runs headless, with JavaScript disabled for your document and no network access except remote images (which you can turn off). Its temporary profile lives in the OS temp folder and is deleted when the browser closes. The browser itself closes after two idle minutes.

## Using it

### Open a document

| What | How | Opens |
|---|---|---|
| **PDF file** | Open it (Explorer, `Ctrl+P`, …) | In the viewer, as the file's editor |
| **Markdown or `.txt` file** | The **PDF button** in the editor title bar (top right) | To the side of the editor |
| | **Alt+click** on the same button | In the current editor group, full width |
| | **Document Viewer: Open PDF Preview to the Side** (`Ctrl+K Shift+P`) | To the side |
| | **Document Viewer: Open PDF Preview** (`Ctrl+Shift+Alt+P`) | In the current group |
| Any of them | Explorer context menu → **Open PDF Preview to the Side** | To the side |

**Another PDF extension installed?** VS Code then asks once, in a notification ("There are multiple default editors available for the resource"). Choose **Keep Document Viewer**. To change it later, right-click a PDF tab → **Reopen Editor With…** → **Configure default editor for '\*.pdf'…**.

For Markdown and text files:
- The setting `markdownPdfViewer.defaultOpenMode` swaps what a plain click and Alt+click do.
- Each file has at most one viewer; opening it again focuses the existing one.
- The PDF is converted again when you **save** the file, keeping your reading position, or when you press **Refresh**. Refresh includes unsaved changes.
- A PDF file is reloaded when it changes on disk.

### The toolbar

| Control | What it does |
|---|---|
| ☰ | Show or hide the list of highlights, notes and the reading position |
| ↑ ↓, page box | Previous/next page, go to a page |
| − / zoom list / + / ↺ | Zoom out, choose a zoom (Fit Width, Fit Page, Actual Size, 50 %–400 %), zoom in, reset to Fit Width |
| ✎ | **Highlight tool**: while it is on, every text selection becomes a highlight |
| ● ● ● ● ● | Highlight color: yellow (default), pink, green, blue, orange. The last color you used is remembered |
| 🔖 ▾ | **Reading marker**: click, then click the line where you stopped reading. The menu also has *Go to* and *Remove* |
| 🎧 | **Reading sounds**: opens a small panel to play rain or fireplace sounds, pause them and set the volume. A dot on the button means a sound is playing |
| ◐ | **Light/dark pages** (remembered for all files). Downloads always use normal light pages |
| ⟳ | Convert again (Markdown/text) or reload from disk (PDF) |
| ⤢ | **Full view** (Markdown/text): move the PDF between "next to the source" and "in the source's editor group". Works with **View: Toggle Maximized Editor Group** and **Zen Mode** |
| ⤓ ▾ | Download the PDF, with highlights and notes (default) or without |

Zoom also works with **Ctrl + mouse wheel** and **trackpad pinch**. Pages are re-rendered sharply at every zoom level and when the VS Code window zoom or the monitor's scale changes.

### Highlighting

- **Highlight tool on**: select text; it is highlighted in the current color.
- **Highlight tool off**: select text and a small bar appears next to the selection. Pick a color, or use 💬 to highlight and write a note right away, or 🔖 to mark that line as your reading position. You can also select text and click a color in the toolbar.
- **Click a highlight** to change its color, add or edit its note, copy its text, or delete it.
- The **☰ list** shows your reading position at the top, then all highlights in document order with their notes and page. Click one to jump to it.

Highlights are attached to the *text*, not to a position on the page. Each one stores the highlighted words plus some text before and after (a W3C Web Annotation *TextQuoteSelector*), with the page and position as hints. Every time the PDF changes, the extension searches for each highlight again, so highlights follow the text when you edit a Markdown or text file. If the text was rewritten so much that it can't be found, the highlight is kept and listed under **Orphaned**, where you can copy its text or delete it.

### Notes

Every highlight can carry a note, for example why you highlighted it.

- **Add or edit**: click the highlight, then 💬 (or click the note text). Type, then press **Ctrl+Enter** or click **Save**. Clicking anywhere else also saves; **Esc** cancels. An empty note removes it.
- **See them**: highlights with a note have a darker underline and a 💬 badge in the right margin. Hover over either to read the note, or click the badge to edit it. The ☰ list shows every note under its highlight.
- **Download**: each note becomes the comment of its PDF annotation, so other PDF readers show it in their comment popups and comment lists.

### Where you stopped reading

The reading marker is a red line with a bookmark tab, at the line where you stopped. There is one per document.

- **Place it**: click 🔖 in the toolbar, then click a line. A dashed guide follows the mouse; **Esc** cancels. Or select some text and click 🔖 in the selection bar.
- **Next time you open the document**, the viewer scrolls straight to the marker and briefly says where you were.
- **Move or remove it**: click its tab, use the 🔖 ▾ menu, or use the ☰ list.
- In Markdown and text files the marker follows the text of the marked line through your edits, like highlights do.

### Reading sounds

<img src="docs/reading-sounds.png" alt="The reading sounds panel below the toolbar: Rain is playing, Fireplace is the other choice, with a pause button and a volume slider at 70 %" width="302">

Click 🎧 in the toolbar to open the panel:
- **Pick a sound**, Rain or Fireplace. It starts right away with a short fade-in; picking the other one crossfades to it.
- **Pause or play** with the round button and set the **volume** with the slider (the arrow keys work too).
- The panel closes as soon as it loses focus: click anywhere else, press **Esc**, or go back to your editor. The sound keeps playing, and the 🎧 button shows a small dot.

The sound never ends and never clicks. Each recording is a four-minute loop whose end blends into its start, and the player takes turns between two copies of it, crossfading for a few seconds at the end of each pass.

- **One sound at a time.** Every viewer's panel shows and controls the same sound, however many documents are open. If you close the document that is playing it, another open viewer takes over; closing the last viewer stops it.
- It keeps playing when you switch to another tab or file.
- The chosen sound and volume are remembered. The command **Document Viewer: Play/Pause Reading Sounds** works from anywhere, and you can give it a shortcut.

The two recordings come from YouTube videos (see [Credits](#credits)). They belong to their creators, so they are **not part of this repository**: `npm run sounds` downloads a few minutes of each video, turns them into seamless loops (`media/sounds/*.ogg`, about 3 MB each, ignored by git), and the build puts them into the `.vsix` you make for yourself. A build without them simply has no 🎧 button.

### Undo and redo

`Ctrl+Z` undoes the last change to your highlights, notes and reading marker, and `Ctrl+Y` or `Ctrl+Shift+Z` redoes it (`Cmd+Z` and `Cmd+Shift+Z` on macOS). That covers:
- creating, recoloring and deleting highlights
- adding, editing and removing notes
- placing, moving and removing the marker
- **Delete All Highlights**

The viewer scrolls to the change and tells you what was undone. After deleting something, a message at the bottom also offers **Undo**. While you are typing a note, `Ctrl+Z` undoes the typing instead. The history lasts while the viewer is open.

### Dark pages

- **Markdown and text files** are converted again with a dark color theme.
- **PDF files** are inverted, keeping their hues, so text turns light on a dark page. Pictures are kept in their real colors. A picture that fills most of a page is probably a scanned page of text, so it is inverted like text.

### Password-protected PDFs

The viewer asks for the password and keeps it in memory only while the PDF is open. When you download such a PDF with highlights, the copy is saved **without** password protection, and the confirmation says so.

### Download

**Download** opens a save dialog in your Downloads folder.
- **Name**: `<file name>.pdf` for Markdown and text files, and `<file name> (highlighted).pdf` or `(copy).pdf` for PDF files. The viewer never overwrites the document you are viewing.
- **With highlights** (the default): each highlight becomes a real PDF highlight annotation, with its color at 40 % opacity and its note as the comment (the highlighted text when there's no note). Acrobat, Edge, Chrome, Firefox, SumatraPDF, Preview and other readers show them. Links stay clickable.
- **Download without highlights** saves the plain PDF.

## Keyboard shortcuts

| Shortcut | Command | When |
|---|---|---|
| `Ctrl+K Shift+P` (macOS `Cmd+K Shift+P`) | Open PDF Preview to the Side | A Markdown or `.txt` editor is focused |
| `Ctrl+Shift+Alt+P` (macOS `Cmd+Shift+Alt+P`) | Open PDF Preview (current group) | A Markdown or `.txt` editor is focused |
| `Ctrl+Z` | Undo the last highlight, note or marker change | The viewer is focused |
| `Ctrl+Y`, `Ctrl+Shift+Z` | Redo | The viewer is focused |
| `Ctrl+Enter` | Save the note | Writing a note |
| `Esc` | Cancel the note, stop placing the marker, close popups | The viewer is focused |
| `Ctrl+=`, `Ctrl+Shift+=`, `Ctrl+Numpad+` | Zoom in (PDF) | The viewer is focused |
| `Ctrl+-`, `Ctrl+Shift+-`, `Ctrl+Numpad-` | Zoom out (PDF) | The viewer is focused |
| `Ctrl+0`, `Ctrl+Numpad0` | Reset zoom to Fit Width (PDF) | The viewer is focused |
| `Ctrl+Wheel`, pinch | Zoom around the pointer | Pointer over the PDF |

When focus is anywhere else, `Ctrl+=`, `Ctrl+-` and `Ctrl+Numpad0` zoom the whole VS Code window as usual. `Ctrl+0` there is VS Code's "Focus Primary Side Bar".

`Ctrl+K P`, the shortcut you might expect, is already VS Code's **Copy Path of Active File**, so the side preview uses `Ctrl+K Shift+P`. You can change shortcuts in **Preferences: Open Keyboard Shortcuts** (search for "Document Viewer").

All commands are in the Command Palette under **Document Viewer:**. Besides the ones above, there are:
- *Mark Where I Stopped Reading*, *Go to Where I Stopped Reading*, *Remove the Reading Marker*
- *Play/Pause Reading Sounds*
- *Undo/Redo Highlight, Note or Marker Change*
- *Toggle Light/Dark Pages*, *Toggle Highlight Tool*, *Toggle Highlights List*
- *Reattach Highlights from Another File…*, *Delete All Highlights for This File*
- *Clear Cached PDFs*, *Reveal Highlight Data Folder*, *Show Log*

## Settings

All settings are user/machine settings. Workspace settings cannot change them, so the extension behaves the same in every workspace and window.

| Setting | Default | Description |
|---|---|---|
| `markdownPdfViewer.defaultOpenMode` | `side` | What a plain click on the title-bar button does: `side` or `full` (Alt+click does the other) |
| `markdownPdfViewer.pageSize` | `A4` | `A4` or `Letter`, for Markdown and text files |
| `markdownPdfViewer.pageNumbers` | `true` | Print "n / N" at the bottom of each page |
| `markdownPdfViewer.renderOnSave` | `true` | Convert again when a Markdown or text file is saved |
| `markdownPdfViewer.allowRemoteImages` | `true` | Download `http(s)` images and embed them in the PDF |
| `markdownPdfViewer.cacheDays` | `7` | Days a converted PDF is kept after it was last opened. `0` turns the cache off and deletes it |
| `markdownPdfViewer.chromiumPath` | *(empty)* | Path to a Chrome/Edge/Chromium executable; empty means detect automatically |
| `markdownPdfViewer.chromiumDownload` | `ask` | `ask`: offer to download Chromium when none is found; `never`: show an error instead |

## Where your data is stored (backup and reset)

Everything lives in VS Code's **global storage** for this extension, never in your folders:

| OS | Folder (default profile) |
|---|---|
| Windows | `%APPDATA%\Code\User\globalStorage\local.markdown-pdf-viewer\` |
| macOS | `~/Library/Application Support/Code/User/globalStorage/local.markdown-pdf-viewer/` |
| Linux | `~/.config/Code/User/globalStorage/local.markdown-pdf-viewer/` |

With a non-default VS Code profile the folder is under `User/profiles/<profile id>/globalStorage/…`; **Document Viewer: Reveal Highlight Data Folder** opens the right one. Insiders builds use `Code - Insiders` instead of `Code`.

Small preferences (the last highlight color, light or dark pages, the chosen reading sound and its volume) are kept in VS Code's own state for the extension rather than in these folders.

### `highlights/`: highlights, notes, reading position, zoom

There is one JSON file per document, named after a SHA-256 hash of the file's absolute path. Shortened:

```json
{
 "schemaVersion": 1,
 "uri": "file:///c%3A/Users/me/papers/article.pdf",
 "fsPath": "c:\\Users\\me\\papers\\article.pdf",
 "view": { "zoom": 1.5 },
 "highlights": [
  {
   "id": "5ee69a55-…", "color": "yellow", "status": "anchored",
   "note": "Compare with the 2019 results.",
   "target": {
    "selector": [
     { "type": "TextQuoteSelector", "exact": "quick brown fox", "prefix": "…The ", "suffix": " jumps over…" },
     { "type": "TextPositionSelector", "start": 41, "end": 56 }
    ],
    "hints": { "pages": [{ "pageIndex": 0, "rects": [[72.4, 701.2, 165.9, 714.6]] }] }
   }
  }
 ],
 "marker": {
  "pageIndex": 11, "y": 0.42, "createdAt": "2026-11-09T21:30:00.000Z",
  "selector": [{ "type": "TextQuoteSelector", "exact": "The second experiment", "prefix": "…", "suffix": "…" }, { "type": "TextPositionSelector", "start": 30211, "end": 30232 }]
 }
}
```

- **Back up**: copy the `highlights` folder. To restore, copy the files back while VS Code is closed.
- **Reset one file**: run **Document Viewer: Delete All Highlights for This File** from its viewer (you can undo it with `Ctrl+Z`), or delete its JSON file.
- **Reset everything**: delete the `highlights` folder.
- Files are written atomically (temporary file + flush + rename), so a crash never leaves a half-written file. If a file is ever unreadable, it is renamed to `….corrupt-<time>.json` and you get a warning.
- **Renames**: when you rename or move a document (or a folder) inside VS Code, its data follows it. If you renamed it outside VS Code (File Explorer, `git mv`), open the new file in the viewer, run **Document Viewer: Reattach Highlights from Another File…** and pick the old entry. Files that no longer exist are listed first. Data of deleted files is kept, so you can reattach it later.
- Global storage is per VS Code profile, so highlights made in one profile are not visible in another.

### `cache/`: converted PDFs

These are the PDFs made from Markdown and text files, one `.pdfcache` file per document and page theme. Reopening a file whose text, settings and images haven't changed shows the cached PDF instantly instead of starting Chromium.
- An entry is replaced when the document changes, and ignored when an image it uses changes.
- Entries are deleted after `markdownPdfViewer.cacheDays` days without use; the cache never exceeds 512 MB.
- **Document Viewer: Clear Cached PDFs** deletes all of them.
- These files are never written next to your documents, and deleting them is always safe.

## What gets converted

### Markdown

Everything the feature test file (`test/fixtures/feature-test.md` in the source) exercises:

- Headings (with GitHub-style anchors and a PDF outline), paragraphs, emphasis, strikethrough, inline code, hard line breaks.
- **Links**: external links open in your browser; `#heading` links jump within the PDF; relative links to other `.md` files open that file in VS Code (and point to `file:///…` in the downloaded PDF).
- **Tables** with column alignment and borders. Wide tables are scaled down to fit (and wrapped if needed), and long tables repeat their header row on every page.
- **Images**: relative paths, absolute paths (`C:\…`, `file:///…`), workspace-root paths (`/images/x.png`, as in VS Code's preview), remote `http(s)` images and SVG. Everything is embedded, so the PDF is self-contained. Missing images produce a visible placeholder and a warning.
- **Code blocks** with syntax highlighting from VS Code's own TextMate grammars (Shiki); long lines wrap.
- Nested lists, task lists, blockquotes, GitHub alerts (`> [!NOTE]` …), footnotes, horizontal rules, inline HTML (`<kbd>`, `<sub>`, `<sup>`, `<mark>`, `<details>`, …), emoji shortcodes, **KaTeX** math (`$…$`, `$$…$$`, `\begin{align}…`, ```` ```math ````) and **Mermaid** diagrams. Front matter is hidden (its `title` becomes the PDF title).
- Print styling:
  - 18/20/16 mm margins, A4 or Letter, page numbers
  - headings kept with their content
  - images, diagrams, short code blocks and table rows never split across pages
  - very tall images scaled to fit a page

### Plain text (`.txt`)

The text appears exactly as written, in a monospace font, with long lines wrapped and columns kept aligned. Nothing is interpreted as Markdown or HTML. Web and mail addresses (`https://…`, `mailto:…`) become clickable links. The text is decoded the way the editor decodes it (`files.encoding`, auto-guessing).

## Troubleshooting

- **PDF files open in another viewer**: right-click the tab → **Reopen Editor With…** → **Document Viewer**. Use **Configure default editor for '\*.pdf'…** in the same list to make it permanent.
- **"needs Chrome, Edge or Chromium"** (Markdown and text only): install one of them, choose a browser executable when asked, or let the extension download Chromium.
- **The browser cannot start** (some company policies block headless browsers): choose **Download Chromium** in the error message, or point `markdownPdfViewer.chromiumPath` at another browser.
- **Downloading Chromium fails behind a proxy**: check VS Code's `http.proxy` settings, then retry.
- **An image is missing**: the yellow banner in the viewer and **Document Viewer: Show Log** list every image or resource that could not be loaded.
- **A converted PDF looks outdated**: press ⟳ (it skips the cache), or run **Document Viewer: Clear Cached PDFs**.
- **There is no 🎧 button**: the package was built without the sound files. Run `npm run sounds`, then `npm run package`, and install the new `.vsix`.
- **"The rain sound could not be played"**: **Document Viewer: Show Log** has the reason. Check that sound works in other apps, then press play again.
- Anything else: run **Document Viewer: Show Log**. You can raise the log level with **Developer: Set Log Level…**.

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
| `npm test` | Unit tests: highlight store, notes and marker, PDF cache, undo stack, reading sounds, text conversion, anchoring, text model, write guard |
| `npm run test:converter` | Renders the feature test and a text file with the installed browser and checks the PDFs with pdf.js |
| `npm run typecheck` | TypeScript type check |
| `npm run sounds` | Downloads the sections of the two sound videos and builds the seamless loops in `media/sounds/`. Needs yt-dlp, and ffmpeg with libvorbis. Downloads are cached in the temp folder; `npm run sounds -- --force` rebuilds |
| `npm run package` | Builds the `.vsix`, with the reading sounds if `npm run sounds` ran. The README pictures in it point to the GitHub repository, because VS Code's extension page only loads `https:` images |

`node test/converter/render-fixture.mjs [file.md] [--theme dark] [--size Letter]` writes a PDF and one PNG per page to the OS temp folder for visual review.

Source layout:

| Folder | Contents |
|---|---|
| `src/converter/` | Markdown/text → HTML → PDF; no `vscode` dependency |
| `src/preview/` | Viewers (preview panels and the PDF custom editor), commands, rendering, downloads |
| `src/store/` | Highlight, note and marker storage |
| `src/cache/` | The disk cache of converted PDFs |
| `src/anchoring/` | Text model and quote matching, shared with the viewer |
| `src/export/` | PDF annotations, the Downloads folder |
| `webview/` | The PDF.js-based viewer: highlights, notes, reading marker, undo stack, dark pages, reading sounds |
| `scripts/` | `fetch-sounds.mjs`, which makes the reading sound loops |
| `docs/` | The pictures in this README |

The loops are Ogg Vorbis because VS Code's built-in Chromium cannot play Opus or AAC.

`PLAN.md` has the original design (version 0.1.0).

## Known limitations

- Highlight edges follow PDF.js's text layer, which approximates glyph positions. On long lines an edge can be off by a fraction of a character.
- PDFs without a text layer (scanned pages) cannot be highlighted. The reading marker still works there.
- Annotations already inside a PDF are displayed but are not editable as highlights.
- Dark pages for PDF files are a color inversion. Diagrams that the PDF stores as pictures keep their light background.
- Renames done outside VS Code are not detected automatically (use *Reattach Highlights*).
- Highlights, notes and markers are per VS Code profile, and the undo history lasts while the viewer is open.
- Reading sounds play only while at least one viewer is open, since a viewer produces the audio. Each VS Code window plays its own.
- Emoji depend on the system's emoji font (built in on Windows and macOS; install Noto Color Emoji on Linux).
- `file:///` links in a downloaded PDF point to absolute paths on your machine, so they only work there.

## Credits

The reading sounds are short loops cut from these YouTube videos:
- **Rain**: [*Rain Sound On Window with Thunder SoundsㅣHeavy Rain for Sleep, Study and Relaxation, Meditation*](https://www.youtube.com/watch?v=mPZkdNFkNps) by **Relaxing Ambience ASMR** (four minutes from 1:34).
- **Fireplace**: [*12 HOURS of Relaxing Fireplace Sounds - Burning Fireplace & Crackling Fire Sounds (NO MUSIC)*](https://www.youtube.com/watch?v=UgHKb_7884o) by **Cat Trumpet** (four minutes from 9:15:08).

The recordings belong to their creators. They are not distributed with this repository and end up only in packages you build yourself.

The viewer is built on [PDF.js](https://mozilla.github.io/pdf.js/). Conversion uses [markdown-it](https://github.com/markdown-it/markdown-it), [Shiki](https://shiki.style/), [KaTeX](https://katex.org/) and [Mermaid](https://mermaid.js.org/), and downloads are annotated with [pdf-lib](https://github.com/cantoo-scribe/pdf-lib). Icons are VS Code's [Codicons](https://github.com/microsoft/vscode-codicons).
