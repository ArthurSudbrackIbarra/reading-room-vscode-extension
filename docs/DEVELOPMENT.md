# Reading Room: development and internals

This is the technical companion of the [README](../README.md), which is written for readers. Here: building from source, the scripts, the source layout, how pages are made, how annotations are stored and kept on their content, and the limits that come from the implementation.

## Contents

- [Build and install from source](#build-and-install-from-source)
- [Scripts](#scripts)
- [Code style: ESLint and Prettier](#code-style-eslint-and-prettier)
- [Source layout](#source-layout)
- [Hard rules](#hard-rules)
- [Making the pages](#making-the-pages)
- [How annotations are anchored](#how-annotations-are-anchored)
- [Translating](#translating)
- [Stored files](#stored-files)
- [The earlier name](#the-earlier-name)
- [Technical limitations](#technical-limitations)

## Build and install from source

You need Node.js 22 or newer and VS Code 1.110 or newer.

```bash
npm install
```

```bash
npm run package
```

```bash
code --install-extension reading-room-0.12.0.vsix --force
```

Then reload VS Code (**Developer: Reload Window**). Installing a newer `.vsix` replaces the previous version and keeps the stored annotations. The extension id is `ArthurSudbrackIbarra.reading-room`. To uninstall: `code --uninstall-extension ArthurSudbrackIbarra.reading-room` (the stored data stays).

To try a build without installing it, open the folder in VS Code and press `F5`, or start VS Code with `--extensionDevelopmentPath=<this folder>` after `npm run build`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` / `npm run watch` | Bundles `dist/extension.js` (CommonJS), `dist/converter/` (lazy-loaded ESM), `dist/translate/worker.js` (the worker thread of the translate tool) and `dist/webview/`, and copies assets |
| `npm run typecheck` | TypeScript type check |
| `npm run lint` / `npm run lint:fix` | ESLint (correctness rules), with or without automatic fixes |
| `npm run format` / `npm run format:check` | Prettier: format every source file, or check that they are formatted |
| `npm run check` | Type check, lint, format check and unit tests, in that order: what to run before a commit |
| `npm test` | Unit tests: stores (with round trips through the 0.4.0 and 0.7.0 store code), drawings and text boxes (geometry, checks on load, annotations read back with pdf.js), colors, notes and marker, PDF cache, undo stack and its stored history, the backup and coming back from it, reading sounds, text conversion, the anchoring engine (scenarios, a seeded property test, performance, real PDFs), the translate tool without its translator (languages and routes, the text given to the translator, the list of language packs, telling the language, language packs on disk with a server that is a function), the write guard |
| `npm run test:converter` | Renders the feature test and a text file with the installed browser and checks the PDFs with pdf.js; renders `test/fixtures/anchoring/base.md`, edits it and checks that annotations follow (`reanchor.test.ts`) |
| `npm run sounds` | Rebuilds the built-in reading sounds in `media/sounds/` from their Freesound recordings: cuts the loops, all at −16 LUFS. Only needed to change them. Needs ffmpeg with libvorbis; `-- --force` rebuilds, and sound ids limit it to those |
| `npm run translation-models` | Rebuilds `src/translate/models.json`, the list of language packs the translate tool offers, from Mozilla's registry of translation models (see [Translating](#translating)). Only needed to pick up new languages and retrained models. Needs the network |
| `npm run package` | Builds the `.vsix`. The README pictures in it point to the GitHub repository, because VS Code's extension page only loads `https:` images |

`node test/converter/render-fixture.mjs [file.md] [--theme dark] [--size Letter]` writes a PDF and one PNG per page to the OS temp folder for visual review.

`ANCHORING_PROPERTY_CASES=5000 npm test` runs the property test of the anchoring engine longer.

## Code style: ESLint and Prettier

- **Prettier** decides how the code looks (`.prettierrc.json`: single quotes, 180 columns, LF line ends). It formats TypeScript, JavaScript, CSS and JSON. Markdown, test fixtures and the lock file are left alone (`.prettierignore`).
- **ESLint** (`eslint.config.mjs`) checks correctness only: the recommended JavaScript and TypeScript rules, `eqeqeq`, inline `type` imports, no unused variables. `eslint-config-prettier` switches off everything that would argue with Prettier.
- **In VS Code**, `.vscode/settings.json` formats on save and applies ESLint fixes on save. It needs the two recommended extensions (Prettier and ESLint; VS Code offers to install them).
- **Before a commit**: `npm run format`, then `npm run check`.
- `.gitattributes` keeps text files at LF line ends on every system, so Prettier and git agree.

## Source layout

| Folder | Contents |
| --- | --- |
| `src/extension.ts` | Activation: the store, the cache, the lazily loaded converter, the commands; brings over the data of the [earlier name](#the-earlier-name) |
| `src/converter/` | Markdown/text → HTML → PDF; no `vscode` dependency |
| `src/preview/` | Viewers (preview panels and the PDF custom editor), commands, rendering, downloads |
| `src/store/` | Highlight, note, drawing, text box and marker storage; the undo history (`HistoryStore.ts`); the copy outside VS Code's storage (`Backup.ts`); the reader's own sounds; `atomicWrite.ts`, the only code that writes into the storage folder and the backup |
| `src/cache/` | The disk cache of converted PDFs |
| `src/anchoring/` | Keeping annotations on their content. Pure TypeScript, no `vscode` and no DOM: the text model, the diff between two versions (`diff.ts`), finding an anchor again (`resolve.ts`), what drawings are bound to (`layout.ts`, `binding.ts`), matching PDF pages (`pageAlign.ts`), resolving everything for one render (`runs.ts`) |
| `src/shared/` | Types, messages, colors, the drawing and text box model and geometry, small rules of the interface (`ui.ts`: size classes, list sections), and what selecting several annotations needs without the DOM (`selection.ts`: Shift+click ranges, moving a group, the clipboard format), shared by the extension and the viewer |
| `src/translate/` | The translate tool on the host: the list of language packs (`registry.ts`, `models.json`), packs on disk (`PackStore.ts`), telling the language (`detect.ts`), the translator in its worker thread (`engine.ts`, `worker.ts`, `EngineWorker.ts`), and what ties them to VS Code (`TranslationService.ts`). Only the last one imports `vscode` |
| `src/export/` | PDF annotations (text boxes in `textBox.ts`), the Downloads folder, a download made from one version of the document (`pin.ts`), the message after it (`summary.ts`) |
| `webview/` | The PDF.js-based viewer: the toolbar (`toolbar.ts`), the tool trays (`drawingBar.ts`), menus (`menu.ts`), the list and the popovers (`panels.ts`), highlights, notes, drawings, text boxes, the color picker, reading marker, undo stack, dark pages, reading sounds. One stylesheet (`styles.css`): its tokens are at the top, and CSS classes keep the prefix `mpv-` from the extension's first name |
| `test/fixtures/store-0.4.0/`, `store-0.7.0/` | The store code of 0.4.0 and 0.7.0, for the downgrade tests |
| `test/unit/anchoring/` | Tests of the anchoring engine (`scenario.ts` has the helpers) |
| `media/sounds/` | The built-in reading sound loops (Ogg Vorbis: VS Code's Chromium cannot play Opus or AAC) |
| `scripts/` | `fetch-sounds.mjs`, which makes the reading sound loops; `fetch-translation-models.mjs`, which makes the list of language packs |
| `docs/` | This file and the pictures of the README |

`PLAN.md` has the original design (version 0.1.0, when the extension only showed Markdown as PDF).

## Hard rules

- **The extension never writes to the reader's documents and never creates files in the workspace.** Files are written only by `src/store/atomicWrite.ts` (the extension's storage folder and [its backup](#the-backup)) and `src/export/downloads.ts` (the path picked in the save dialog). `test/unit/writeGuard.test.ts` fails when any other source file calls a write API.
- **`src/anchoring/` stays pure**: no `vscode`, no DOM, so it is unit-tested as it runs.
- **The webview's CSP is strict**: no inline style attributes in markup, no `eval`, no markup strings. Styles go through CSSOM and icons are built with DOM calls.
- **Settings have `"scope": "application"`** (or `machine`), so a workspace cannot change how the extension behaves.
- **Nothing is deleted automatically**: annotations whose content is gone are kept as orphans.
- **What the reader reads stays on the computer.** The extension uses the network for three things only, each of them a download: remote images of a Markdown file (`readingRoom.allowRemoteImages`), Chromium when no browser is found, and a language pack of the translate tool. The last two ask first. Text is never sent anywhere.

## Making the pages

Markdown and text files are turned into HTML (markdown-it with plugins, Shiki, KaTeX, Mermaid) and printed to PDF by a Chromium-based browser through `puppeteer-core`. The browser is, in this order: the one in `readingRoom.chromiumPath`, an installed Chrome, Edge, Chromium or Brave, or a _chrome-headless-shell_ downloaded earlier into the storage folder (about 126 MB, only after asking; `readingRoom.chromiumDownload: never` forbids it).

- The browser runs headless, with JavaScript disabled for the document and no network access except remote images (`readingRoom.allowRemoteImages`). Its temporary profile is in the OS temp folder and is deleted when the browser closes, which it does after two idle minutes.
- Print styling (`src/converter/print.css`): margins of 18/20/16 mm, A4 or Letter, page numbers; headings kept with their content; images, diagrams, short code blocks and table rows never split; very tall images scaled to a page; wide tables scaled down, long ones repeat their header row.
- Images of every kind (relative, absolute, workspace-root, remote, SVG) are embedded, so the PDF is self-contained. A missing image becomes a visible placeholder and a warning.
- Links: external ones stay; `#heading` links become PDF destinations; relative links to other files are written as `file:///…` and mapped back when clicked in the viewer.
- Text files are decoded the way the editor decodes them (`files.encoding`, auto-guessing), shown in a monospace font, with web and mail addresses as links.
- Converted PDFs are cached per document and page theme (`cache/`, see below).
- PDF files are shown by PDF.js as they are. Dark pages for them are a color inversion that keeps hues; pictures are inverted back, except those that fill most of a page (probably a scan of text).

## How annotations are anchored

Every annotation is attached to content, not to a position.

- **The text model** (`src/anchoring/textModel.ts`): the text of all pages as PDF.js reports it, with whitespace runs collapsed to one space and header and footer text left out. Offsets into it map back to (page, text item, character).
- **An anchor** (`anchor.ts`) is what the reader chose: the exact text, 64 characters before and after, a word fingerprint, and the version it was made in. **A state** is derived: where the anchor was last found, in which version, and how (`exact`, `shifted`, `edited`, `partial`, `moved`), or why not (`deleted`, `replaced`, `not-found`, `page-missing`, `invalid`).
- **Resolving** (`resolve.ts`), in this order: the same text as last time → nothing to do; a diff from the version it was last found in (kept in memory, or as a snapshot on disk) maps the old range to the new text; otherwise a search for the quote with its surroundings. The thresholds are named constants at the top of the file.
- **The diff** (`diff.ts`): a patience diff anchored on sentences, a word-level Myers diff inside what changed, and a character refinement at the edges, within a time budget.
- **Drawings and text boxes** (`binding.ts`, `layout.ts`) get a binding when they are made, moved or resized: `text-stretch` (fitted to the words of one line), `text-pin` (pinned to the first words under them; text boxes always), `span` (two ends on two words, or a mark beside some lines), `line`, `block` (a picture or a diagram) or `page`. Their stored points never change by themselves; the place on screen is computed for each render.
- **PDF files that are replaced** (`pageAlign.ts`): pages are matched by their text, or by a signature of how they look when they have none.
- **Runs** (`runs.ts`): one resolving run at a time per document, a quick pass and a slower one, each annotation on its own (one failure never stops the others), a summary for the message at the bottom and for the banner when most annotations are orphaned.
- **The viewer** (`webview/anchoring.ts`) reads a new PDF and places every annotation in it before the screen switches. A stroke being drawn or a note being typed is not interrupted. Renders of unsaved text are shown but not stored. A download is made from one version of the document.
- **Selections** become text ranges through the PDF.js text layer (`webview/highlights.ts`, `boundaryIndex`). A selection that ends at an element boundary (right in front of a differently styled piece of text) ends before that piece, not after it.

## Translating

The translate tool runs a translator inside VS Code: [Bergamot](https://github.com/browsermt/bergamot-translator) built to WebAssembly (the engine of Firefox's page translation), with the models Mozilla trains for Firefox. Nothing is sent to a service.

- **The engine** is the npm package `@browsermt/bergamot-translator` as published (0.4.9, from 2022). It loads the models Mozilla publishes today; after `npm run translation-models`, translating once with a newly listed pack in a real window is the check that it still does. Its two files, Emscripten's glue script and the `.wasm`, are copied to `dist/translate/` unchanged, with `NOTICE.txt` (the engine is under the Mozilla Public License 2.0). `src/translate/engine.ts` is what Node needs around them: it runs the glue script with a `Module` object of its own, and gives the module the 8-bit matrix routines it imports (its own fallbacks, under the names it asks for).
- **The worker thread** (`worker.ts`, bundled to `dist/translate/worker.js`; `EngineWorker.ts` is the host's side of it). Translating blocks, so it never runs in the extension host itself. The WebAssembly memory grows to about 550 MB with the first translation of a model (750 MB for the larger ones, 1.2 GB with two models) and is never given back while the module lives, whatever the `workspace` setting of the model says. So the thread is ended after 60 idle seconds, and started afresh when another pair of languages is asked for, instead of loading more models into the same one. Starting it and loading a model takes about 100 ms.
- **Language packs** (`registry.ts`, `PackStore.ts`). Mozilla's registry (`db/models.json` in its storage bucket) lists the models of each direction; all are to or from English. `selectEntry` picks one: a released model, and of two the one made to use less memory (`base-memory` before `base` before `tiny`). `src/translate/models.json` is the list made of it (116 packs), shipped with the extension: where the files of each pack are, the SHA-256 and size of its model, and the size of the download. So nothing is asked from any server before the reader agreed to a download, and what is downloaded is checked against a hash that came with the extension. (The registry has hashes for the models only, not for the vocabularies and shortlists.) A download is unpacked and checked in memory, then written through `atomicWrite.ts` into `translation/<pair>/` with fixed file names; `pack.json` is written last, and a folder without it is not a pack. When a file of the shipped list is gone from the server (the model was trained again), Mozilla's registry is read once and its pack is used.
- **The way from one language to another** (`src/shared/translate.ts`, `routeFor`): one pack with English at an end, two otherwise (`translateViaPivoting` of the engine). Bosnian, Croatian and Serbian are read with the pack of their macrolanguage (`hbs-en`).
- **Telling the language** (`detect.ts`), in the worker thread too. Kana and hangul decide at once. A long text (160 letters) is told by franc, which knows every language there is a pack for. A sentence is told by tinyld, which is much better at short text but does not know thirteen of the languages: where the document around the sentence is in one of those, the document is believed. A few words (under 40 letters) are told by the document around them, which the viewer sends along (`contextOf`, 1,600 characters).
- **The text** (`readingText`): the text model has one space where a line ends. There, a hyphen between two lowercase letters is taken out with the space ("sen- tence"), and so is a space between two characters of a script written without spaces. Long texts are cut at the ends of sentences into pieces of 1,200 characters (`chunkText`), and the viewer shows what is translated so far.
- **Requests** are served one at a time (`TranslationService`): they share the translator, and two must not ask about the same download. A new request of a viewer, or closing the translation, drops the one before it. A download that is under way goes on.
- **In the viewer** (`webview/translate.ts`): the language menus and the popover. The translate tool is a mode like the highlight tool (`translateActive` in `main.ts`), not one of the drawing modes.

## Stored files

Everything is in VS Code's global storage for the extension:

| OS | Folder (default profile) |
| --- | --- |
| Windows | `%APPDATA%\Code\User\globalStorage\arthursudbrackibarra.reading-room\` |
| macOS | `~/Library/Application Support/Code/User/globalStorage/arthursudbrackibarra.reading-room/` |
| Linux | `~/.config/Code/User/globalStorage/arthursudbrackibarra.reading-room/` |

With another VS Code profile the folder is under `User/profiles/<profile id>/globalStorage/…`; **Reading Room: Reveal Annotation Data Folder** opens the right one. Small preferences (the last colors, tools, widths, eraser size and text style, recent custom colors, light or dark pages, the chosen sounds and their volume) are in VS Code's own state for the extension.

### `highlights/`

One JSON file per document, named after a SHA-256 hash of the file's absolute path. Shortened:

```json
{
  "schemaVersion": 1,
  "uri": "file:///c%3A/Users/me/papers/article.pdf",
  "fsPath": "c:\\Users\\me\\papers\\article.pdf",
  "view": { "zoom": 1.5 },
  "highlights": [
    {
      "id": "5ee69a55-…",
      "color": "yellow",
      "status": "anchored",
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
  "marker": { "pageIndex": 11, "y": 0.42, "createdAt": "2026-11-09T21:30:00.000Z", "selector": ["…"] }
}
```

The selectors are W3C Web Annotation selectors. Next to it:

- **`<hash>.drawings.json`**: drawings and text boxes, in PDF units of their page (zooming never changes them). A drawing has its tool, color (a name such as `red`, or a hex code), width, page and points. What the eraser leaves of a drawing is a pen stroke marked `"polyline": true`. A text box has its text, top left corner, size, alignment, color, the bold, italic and underlined parts (`spans`) and, if set, its width.
- **`<hash>.anchors.json`** (since 0.8): what each highlight, the marker and each drawing is attached to, and where that was last found. Earlier versions never read it, and the two files above keep their format, so going back to an earlier version loses nothing.
- **`<hash>.text-<id>.gz`** (since 0.8): a compressed copy of the document's text for the versions annotations were last found in (at most twelve, 4 MB). `readingRoom.textSnapshots` turns them off.
- **`<hash>.history.json`** (since 0.13): the undo history, `done` (oldest first) and `undone` (the next redo last). A step is a label and an operation that holds whole annotations (`create`, `delete`, `update`, `replace`, `marker`, `createDrawing`, `deleteDrawing`, `updateDrawing`, or a `batch` of them), so it can be reverted without anything else. At most 500 steps each way and 2 MB; the oldest go first. It stays when a document has no annotations left, because deleting them can be undone.

Rules of the store:

- Files are written atomically (temporary file, flush, rename). An unreadable file is renamed to `….corrupt-<time>.json` with a warning.
- The drawings and anchors files are written only when what they hold changed.
- Data written by a newer version is shown but not changed, and never treated as damaged.
- A rename or move inside VS Code moves the files; **Reattach Annotations from Another File…** copies them for renames done elsewhere. Data of deleted files is kept.
- Keeping drawings in their own file means that version 0.4, which rewrites the first file with only the fields it knows, cannot erase them.

How undo lasts (`src/shared/history.ts`, `src/store/HistoryStore.ts`, `webview/undo.ts`):

- The viewer keeps the stack while it is open and reports every change of it to the host (`push`, `undo`, `redo`, `clear`); the host applies the same change to its copy and writes it, coalesced. The viewer starts from that copy when the document is opened again.
- Every step the viewer sends, and every step read from disk, is checked like stored annotations. A step that fails the check clears the stored copy (it would no longer match the viewer's); a broken step in a file makes what is older than it unreachable.
- A step from an earlier session may be about something that is gone or back by other means (another window, files put back by hand). The viewer skips such a part and applies the rest.
- The history follows a renamed document (`onMigrate` of the store). **Reattach** leaves it alone: what it adds does not undo what was done here.

### The backup

VS Code deletes `globalStorage/<id>` when an extension is uninstalled (at its next start). So `highlights/` has a second copy outside VS Code (`src/store/Backup.ts`):

| OS | Folder |
| --- | --- |
| Windows | `%APPDATA%\Reading Room\backup\highlights\` |
| macOS | `~/Library/Application Support/Reading Room/backup/highlights/` |
| Linux | `$XDG_DATA_HOME/reading-room/backup/highlights/` (`~/.local/share/…` by default) |

- The two stores report every file they write, move or remove (`onFilesChanged`, by the document's key). A second later the backup makes its files of that document the same as the storage folder's: changed ones are copied (atomically), missing ones removed. A document that cannot be copied does not hold up the others and is tried again with the next change.
- At start, files the backup does not have, or has an older version of, are copied. Nothing is removed then: several profiles and editors share the folder, and each of them only removes what it removed itself.
- When the extension starts and `highlights/` is missing or empty, it is copied from the backup (`adoptEarlierData` in `src/extension.ts`, before anything reads the store), and the reader is told. Otherwise the backup is never read.
- `sounds/`, `cache/` and `translation/` are not in it: sound files can be 150 MB each, and the cache and the language packs are made or downloaded again.
- A backup that cannot be written never gets in the way: it is logged once per run of failures.
- Tests that start a real VS Code must point `APPDATA` (or `XDG_DATA_HOME`) at a scratch folder, or they write into the reader's own backup.

### `cache/`

The PDFs made from Markdown and text files, one `.pdfcache` file per document and page theme. An entry is replaced when the document changes and ignored when an image it uses changes. Entries are deleted after `readingRoom.cacheDays` days without use; the cache never exceeds 512 MB. Deleting it is always safe.

### `translation/`

The language packs of the translate tool, one folder per direction (`ja-en/`): `model.bin`, `shortlist.bin`, `vocab.spm` (or `srcvocab.spm` and `trgvocab.spm`) and `pack.json`, which lists them with their sizes and hashes. 17 to 55 MB each on disk. Not in the backup: a pack is downloaded again when it is needed. Deleting the folder is always safe.

### `sounds/`

A copy of every sound file the reader added (`custom-<id>.<ext>`) and `sounds.json` with their names and the gain that makes each as loud as the built-in ones (measured when it is added; a limiter keeps raised peaks from clipping). Built-in loops are four minutes long, their end blended into their start, and the player crossfades between two copies.

## Earlier ids

VS Code names an extension's storage folder after its id, so every id the extension had left a folder of its own:

| Id | Versions | What it was |
| --- | --- | --- |
| `local.markdown-pdf-viewer` | up to 0.8.0 | **Document Viewer & Highlighter**, with the settings and commands `markdownPdfViewer.*` |
| `local.reading-room` | 0.9.0 to 0.11.0 | Reading Room (`readingRoom.*`), installed from a `.vsix`, before it had a publisher |
| `ArthurSudbrackIbarra.reading-room` | from 0.12.0 | Reading Room on the Marketplace |

- When Reading Room starts without them, it copies `highlights/` from [the backup](#the-backup) or else from the newest earlier folder that has it, and `sounds/` from the newest earlier folder that has it (`adoptEarlierData` in `src/extension.ts`, `copyFolderFromFirst` in `src/store/atomicWrite.ts`). The earlier folder is left as it is. A folder that already exists in the new place is never replaced.
- Small preferences (last colors, the chosen sound, the volume) start fresh, because VS Code keeps them per extension id.
- Settings under `markdownPdfViewer.*` and a `"*.pdf": "markdownPdfViewer.pdf"` entry in `workbench.editorAssociations` are not migrated: set them again under the new names. Settings under `readingRoom.*` carry over as they are.
- A copy with the id `local.reading-room` that is still installed keeps working, and Reading Room stays inactive next to it and offers to **switch** (`offerSwitch` in `src/extension.ts`): it copies the data as it is at that moment, uninstalls the earlier copy and reloads the window, in that order. The order matters: VS Code deletes the storage folder of an extension some time after it is uninstalled, so never uninstall the earlier copy before its data was copied.

## Technical limitations

- Highlight edges follow PDF.js's text layer, which approximates glyph positions: on long lines an edge can be off by a fraction of a character.
- Where a drawing is attached is worked out from the PDF's text positions, exact for a line and approximate inside it: after its words changed, a circle can sit a couple of points off them.
- Two identical passages cannot be told apart by their text. A duplicate made inside VS Code is told from the original by the edit itself; one made outside VS Code, or with the cursor at the very start of the line, is not.
- Drawings on a formula or a diagram follow the nearest line of ordinary text or the diagram's box: the browser does not always write those to the PDF in the same order.
- On PDF pages whose text runs sideways as shown, drawings bind to the page.
- Very short quotes whose surroundings were rewritten completely are orphaned rather than searched for approximately.
- Text boxes are exported in Helvetica with the standard encoding: characters outside it become "?" (the annotation's comment keeps the real text).
- Dark pages for PDF files are an inversion; diagrams stored as pictures keep their light background.
- Emoji depend on the system's emoji font. `file:///` links in a downloaded PDF only work on the machine that made it.
- The translate tool's engine was built in 2022. If Mozilla changes the format of its models, new packs will not load until the engine is built again from [mozilla/translations](https://github.com/mozilla/translations); packs already on a computer keep working.
- The language of a short text in one of the thirteen languages the short-text detector does not know (Catalan, Croatian, Galician, Slovenian and others) is told from the document around it, so a single sentence of them quoted in a document of another language is taken for a neighbor.
- Version 0.5 does not know text boxes or picked colors, and 0.6 shows styled text as plain: going back to them drops those when they save a file.
