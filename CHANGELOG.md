# Changelog

## 0.3.1 — 2026-11-10

- **Reading sounds no longer stop by themselves.** VS Code lets a viewer start audio only while handling a click in it, and the second player that takes over at the end of each four-minute pass never had one, so the sound stopped at the first loop point. Now the viewer unlocks all its players at your first click or key press in it, and they take turns for as long as you like.
  - If the next pass still cannot start, the current one simply loops on its own instead of stopping.
  - A viewer that takes over the sound before you have clicked in it (for example after you closed the one that was playing) waits for your first click there and says so, instead of stopping the sound everywhere.
  - Pausing from outside the viewer (media keys, the system's media controls) now pauses it everywhere, so the panels never show a silent sound as playing.
  - While nothing plays, the viewer's audio output sleeps.
- **Louder**: both loops now have the same loudness (−16 LUFS), so 100 % is about as loud as a podcast. That is 6 dB more for the rain and 15 dB more for the fireplace, whose crackles are limited faster so the fire stays steady between them.
- The sounds panel no longer shows "Playing on a loop".

## 0.3.0 — 2026-11-10

- **Reading sounds**: a 🎧 button in the viewer toolbar opens a small floating panel with **Rain** and **Fireplace**, play/pause and a volume slider. The panel closes as soon as it loses focus.
  - The sounds loop forever without a gap: each is a four-minute loop whose end blends into its start, played by two alternating players that crossfade at the end of each pass. Fades and volume run on the audio clock, so they stay smooth in background tabs.
  - One sound plays at a time across all open viewers; every viewer shows and controls it, and closing the viewer that plays it hands it to another one. The sound and volume are remembered.
  - New command: *Play/Pause Reading Sounds*.
  - The audio comes from two YouTube videos (credited in the README) and is not in the repository: `npm run sounds` (yt-dlp + ffmpeg) builds the loops into `media/sounds/`, and `npm run package` includes them. Without them the button is hidden.
- README rewritten for everything the extension does now, with screenshots.
- `package.json` now names the GitHub repository, so the README pictures on the extension's page load from GitHub (`npm run package` uses `--githubBranch main`).

## 0.2.0 — 2026-11-09

Now a general document viewer: **Document Viewer & Highlighter**. The extension ID, setting names and stored data are unchanged, so updating keeps everything.

- **PDF files** open directly in the viewer (a custom editor), exactly as they are, with the same highlighting, notes, reading marker, zoom and download. They reload when the file changes on disk. Password-protected PDFs ask for the password.
- **Plain text (`.txt`) files** get the same PDF preview as Markdown: the text exactly as written in a monospace font, with web addresses linked.
- **Notes on highlights**: add a note from the highlight popover, or highlight and write a note in one step from the selection bar. Notes show on hover and as a badge in the margin, are listed under their highlight, and become the comment of the PDF annotation when you download.
- **Reading marker**: mark the line where you stopped reading (toolbar, selection bar or Command Palette). Opening the document again jumps there. It follows the text through edits of Markdown and text files.
- **Undo/redo** (`Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z`) for highlights, colors, notes, the reading marker and *Delete All Highlights*, with an "Undo" button after deletions. In the note box, `Ctrl+Z` undoes typing.
- **PDF cache**: converted Markdown and text files are cached in the extension's storage (`markdownPdfViewer.cacheDays`, default 7 days; 512 MB at most), so reopening an unchanged file is instant. The cache entry is ignored when an image the document uses changes. New command: *Clear Cached PDFs*.
- Dark pages for PDF files: the page is inverted, keeping its hues, and pictures keep their real colors.
- New icon and name. Commands moved to the **Document Viewer:** category.

## 0.1.0 — 2026-11-06

First release.

- Markdown → PDF with Chromium print-to-PDF, rendered in memory (markdown-it, Shiki, KaTeX, Mermaid, GitHub alerts, task lists, footnotes, emoji, front matter).
- PDF.js viewer in a VS Code panel: side or full view (toggle), page navigation, text selection, zoom (toolbar, Ctrl+wheel, pinch, Ctrl+= / Ctrl+- / Ctrl+0 when the viewer is focused), re-render on save keeping the position.
- Light/dark page themes.
- Highlights in five colors, anchored to the text (W3C TextQuoteSelector), re-anchored after edits, orphan list, per-file storage in global storage with atomic writes, rename/move migration.
- Download with highlights as real PDF annotations, or without.
