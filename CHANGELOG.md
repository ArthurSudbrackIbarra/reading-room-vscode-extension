# Changelog

## 0.1.0 — 2026-11-06

First release.

- Markdown → PDF with Chromium print-to-PDF, rendered in memory (markdown-it, Shiki, KaTeX, Mermaid, GitHub alerts, task lists, footnotes, emoji, front matter).
- PDF.js viewer in a VS Code panel: side or full view (toggle), page navigation, text selection, zoom (toolbar, Ctrl+wheel, pinch, Ctrl+= / Ctrl+- / Ctrl+0 when the viewer is focused), re-render on save keeping the position.
- Light/dark page themes.
- Highlights in five colors, anchored to the text (W3C TextQuoteSelector), re-anchored after edits, orphan list, per-file storage in global storage with atomic writes, rename/move migration.
- Download with highlights as real PDF annotations, or without.
