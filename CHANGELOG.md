# Changelog

## 0.11.0 — 2026-11-13

- **A select tool**, the pointer in the toolbar, takes the place of the remove tool.
  - **Click** a highlight, a drawing or a text box to select it, or **drag a rectangle** around several. The rectangle takes the strokes it touches, not everything whose corner it reaches.
  - **Ctrl+click** adds one to the selection or takes it out. **Shift+click** selects everything from the last one clicked to this one, in reading order. `Ctrl+A` selects everything.
  - **Drag** one of the selected drawings or text boxes to move them all together, as one undo step. Each stays on its own page.
  - **Delete** deletes everything selected, highlights included, as one undo step.
  - Its tray has **Select all**, **Copy**, **Paste** and **Delete**, and says how many things are selected. **Esc** lets go of the selection first, then turns the tool off.
- **Copy, cut and paste** for drawings and text boxes: `Ctrl+C`, `Ctrl+X` and `Ctrl+V`, the select tray, and a new **Copy** button in the bar of a drawing and of a text box. A paste lands on the page in view, where the original was on its page; on the original's own page it lands a little down and to the right. What is pasted is selected, ready to be dragged. Copying highlights copies their text.
- **Several things can be selected without the select tool too**: `Ctrl+click` drawings, text boxes and highlights, then move, copy or delete them together. `Delete` now works on everything that is selected.
- **The tray looks like the toolbar.** No blue tint, no blue line, and no arrow from the tool to the tray. The tray starts with the name of the mode, **HIGHLIGHT MODE**, **DRAW MODE**, **TEXT MODE**, **SELECT MODE** or **MARKER MODE**, and the options follow right after it. **Done** is a plain outlined button.
- **The arrows of the reading marker and download buttons are centered** in the part that lights up under the pointer, and so are their icons.
- **A little more room** under the reading position at the top of the annotations list, before the first section.
- **The title-bar button** that opens a file in Reading Room is the book with the red ribbon, the same as on the tab.
- **Reading sounds**: the line under **Custom** now only says that you can add your own audio files, that they play in a loop, and which formats are accepted.
- The command **Toggle Remove Tool** is now **Toggle Select Mode**. If you gave it a shortcut, set it again.

## 0.10.0 — 2026-11-12

A redesign of the whole viewer: a calm bar while reading, and one way of showing what is on.

- **A toolbar in three groups that never wraps.** Finding your place (the list, the page, the zoom) on the left, the tools in the middle, the room (sounds, download, More) on the right. In a narrow panel the bar stays one row: what does not fit moves into the new **⋯ More** menu, which always lists exactly what is missing from the bar.
- **The four tools share one frame**, in the order highlight, draw, text, remove. The one that is on is tinted and outlined, and a small arrow ties it to its **tray**, the row under the toolbar.
- **Every tool has a tray, and every tray ends with Done.** Highlight and remove got one too, and so did placing the reading marker (with **Cancel**). The tray says which tool is on and what it does. Done, a second click on the tool and **Esc** all turn it off. The pages stay where they are on screen when a tray opens or closes.
- **The highlight colors moved into the highlight tool's tray.** They are still in the bar next to a selection and in a highlight's own bar. The band under the highlighter shows the current color.
- **Dark pages, Full view and Convert again moved into ⋯ More.** Dark pages and Full view show a check when they are on.
- **The page and the zoom are one control each.** The page is "n / N" between its two arrows, with the number as far from one arrow as the count is from the other. The zoom is −, its value and +; the value opens the list of zoom levels.
- **"On" follows your color theme.** A tint and an outline in the theme's own accent color, stronger for the tool that is on, lighter for a picked option (a drawing tool, a width, bold, an alignment). High-contrast themes show state with lines only. Options of which exactly one is picked sit together in a frame; toggles stand alone.
- **Menus instead of the system's lists** for the zoom, the font size and what a drawing follows: they look like the rest and work with the keyboard (`↓` or `Enter` opens, `↑` `↓` `Home` `End` move, typing jumps, `Esc` closes).
- **The annotations list**:
  - **Search** highlights by their text and their notes, show only some **colors**, or only highlights **with notes**.
  - Sections **collapse** (remembered for all files), and each shows its count.
  - **A click selects an entry**, and what can be done with it opens under it. Nothing depends on hovering any more, so everything works with the keyboard and on touch screens.
  - A changed highlight is marked **Changed**, with the old text struck through and **Keep as it is now** always in view. A drawing that is not shown is marked **Not shown**, with **Put back on the page**.
  - An empty list says what goes there and how to start.
- **All popups look alike** and have the same order: how it looks, what you can do with it, delete last. The text box's bar has two rows and is much narrower. Writing a note grows the highlight's bar in place. Every delete button turns red under the pointer.
- **Reading sounds**: the three kinds are one row, recordings are a list of radio rows, and **rename** and **remove** of your own sounds are on the picked row instead of appearing on hover.
- **New icons**: two A's for the text tool, a wand with an × for the remove tool (and for its cursor, whose tip is what points), minus and plus for the zoom.
- **A new face**: a new extension icon (an open book with a highlighted line and the red ribbon), a book on the tab, and the tab's title is the file's name (no more "PDF:").
- **Messages**: toasts are pills; a restored tab that is not at the reading marker offers to **Continue** there; the first load shows the name of the file being opened.
- On the page: the reading marker is a thinner line with a rounder tab, which also follows the pointer while it is being placed; selected drawings and text boxes get an outline that shows on white and on dark pages.
- **Fixed**: the eraser's hint and the placing hint no longer cover the bottom of the page as toasts (the trays say it).

## 0.9.0 — 2026-11-12

- **A new name: Reading Room.** The extension grew from a PDF preview into a place to read and study, and is now named and described that way. Everything that carried the old name follows:
  - Commands are under **Reading Room** in the Command Palette. The two that open a file are **Open in Reading Room to the Side** (`Ctrl+K Shift+R`, was `Ctrl+K Shift+P`) and **Open in Reading Room** (`Ctrl+Shift+Alt+R`, was `Ctrl+Shift+Alt+P`); the title-bar button is a book.
  - Settings are `readingRoom.*` (were `markdownPdfViewer.*`), and the extension id is `local.reading-room`.
  - **Your annotations and your own sounds come along**: the first time Reading Room starts, it copies them from the storage of Document Viewer & Highlighter (which is left as it is). Small preferences, such as the last colors and the volume, start fresh. Uninstall the old extension so that only one of them opens PDF files.
- **An undo button** in the toolbar, where the reset-zoom button was (its icon looked like undo). It takes back the last change, or the typing while you type in a text box; its tooltip says what it will take back, and it is dimmed when there is nothing. The reset-zoom button, its command and `Ctrl+0` are gone: **Fit Width** in the zoom list does the same.
- **The eraser shows what it rubs out, also while you drag**: a ring follows the pointer and stays while the button is down (the round cursor used to vanish as soon as you pressed). With the eraser picked, the three widths of the drawing bar are its three **sizes** (small, medium, large), shown as circles, and the ring is exactly as large as what is rubbed out. The size is remembered apart from the pen's width.
- **The remove tool has its own look**: the toolbar's eraser, which deletes whole highlights, drawings and text boxes, is now called **Remove** and shows a pointer with an ×, as does its cursor on the page. It no longer looks like the eraser of the drawing bar, which rubs out part of a drawing.
- **"DRAW MODE" and "TEXT MODE"** in words at the start of the second row, instead of the mode's icon repeated there, which looked like one more tool.
- **What is on is easier to see**: a tool that is on, and what is picked in the second row (the drawing tool, the width or eraser size, bold, italic, underline, the alignment), has a light blue fill and a blue border, in every color theme. The ring around the picked highlight color uses the same blue.
- **Fixed: a highlight that took the whole last line.** A selection that ended right in front of a differently styled piece of text (bold words, a link, inline code) was extended to the end of that piece, often the rest of the line. It now ends where the selection ends.
- **README for readers**: the README now holds what someone using the extension needs. Building from source, the source layout, how annotations are anchored and the format of the stored files moved to `docs/DEVELOPMENT.md`.
- **For development**: ESLint and Prettier are set up (`npm run lint`, `npm run format`, `npm run check`), the code is formatted with Prettier, and VS Code formats on save.

## 0.8.0 — 2026-11-11

- **Annotations survive changes to the document.** Highlights, notes, the reading marker, drawings and text boxes now follow their content through any change of the file: edits in VS Code, a formatter, `git checkout`, another program, a replaced PDF.
  - The text of the version an annotation was last found in is compared with the new text, so a highlight moves exactly with its words: across pages, through reflow, and past identical passages elsewhere. Without that text (first time, or the setting off) it is searched for by its words and what surrounds them.
  - **Words changed inside a highlight**: it stays on the passage, and the list shows *was … / now …* with a ✓ to keep it. **Its start or end deleted**: it shrinks to the rest. **All of it deleted**: it is orphaned with the reason and the page it was on. **Replaced**: one click attaches it to the text that took its place. **Cut and pasted elsewhere**: it moves along. **A copy pasted next to it**: it stays on the original.
  - **When the text comes back** (undo, `git checkout`, a restored file), everything returns to where it was, by itself, also after a restart. Nothing is ever deleted automatically; *Delete all orphaned* is one undoable step.
- **Drawings and text boxes are attached to what they cover**: the words of a line (they are fitted to them again), several lines (pinned), two words (an arrow follows both ends), lines beside a margin mark, a picture (they scale with it), or the page (scans). A menu on their small bar shows what they follow and lets you choose. When their content is gone they are listed as not shown, and can be put back on the page.
- **The reading marker** follows its line; when the line is deleted it stands where the line was, drawn dashed, and returns with the line. What the marker's position is in the current version no longer overwrites where you placed it.
- **PDF files**: when a PDF is replaced, pages are matched to the pages before (by text; scanned pages by how they look), so drawings and the marker stay on their page when pages are added, removed or reordered. Highlights on pages turned by `/Rotate`, or with a crop box that does not start at zero, are now placed and exported correctly.
- **Never a wrong picture**: a new version of the PDF is read, and every annotation placed in it, before the viewer switches to it; nothing computed for one version is drawn on another. A download's annotations are computed for the very PDF that is downloaded (a save in the middle of a download is handled). A render of unsaved text shows its results without storing them.
- **A line at the bottom** tells what a change did to your annotations, and a banner appears when most of them are missing from the current version of the file.
- **Storage**: what is new is kept in new files (`<hash>.anchors.json`, and compressed copies of the text, `<hash>.text-<id>.gz`); the files of earlier versions keep their format, so going back to an earlier version loses nothing. Data from a newer version is opened read-only instead of being moved aside. The drawings and anchors files are written only when what they hold changed (not when you zoom). New setting `markdownPdfViewer.textSnapshots`.
- Opening long documents is faster (pages are read in parallel), and re-anchoring 500 highlights after an edit in a 300-page document takes about 30 ms.

## 0.7.0 — 2026-11-11

- **An eraser for everything**: the new eraser button in the toolbar (or *Toggle Eraser*) deletes highlights, drawings and text boxes. What is under the pointer fades to show what a click would delete; a click deletes it, a drag deletes everything it goes over, and each click or drag is one undo step. Esc during a drag keeps everything.
- **The drawing bar's eraser now rubs out**: it removes only the part of a drawing it goes over, like an eraser on paper, and what is left keeps its exact shape (corners stay corners, curves stay curves). Cut a line in two, shorten an arrow, open a rectangle. One drag is one undo step, and Esc during a drag puts everything back. Its round cursor is its size.
- **Bold, italic and underline on part of a text**: while typing in a text box, select some of the text and click B, I or U (or press Ctrl+B, Ctrl+I, Ctrl+U): only that part changes. With nothing selected they apply to what you type next, and the buttons show the style at the caret. A selected box's bar still changes all of its text at once. Downloads switch between Helvetica's regular, bold, oblique and bold oblique faces inside a line and underline only the underlined part. Text boxes of 0.6.0 keep their look.
  - Typing has its own undo: Ctrl+Z and Ctrl+Y undo and redo the typing and the styling while you type; afterwards the whole edit is one step. Pasted text comes in as plain text.
- **The same keys for everything**: Delete (or Backspace) deletes what is selected, whatever it is: a drawing, a text box, the highlight whose small bar is open (it now shows darker while it is), the reading marker whose bar is open, or the focused row of the list. Enter edits it: types in the text box, opens the highlight's note. Ctrl+Z and Ctrl+Y undo and redo all of it, and Esc backs out of whatever is going on.
- **Drawing and text bars**: their groups are divided by lines again, with the same tight spacing as the toolbar, so the tools no longer look scattered. Each bar starts with its mode's icon in a box as wide as a button, which puts its first divider exactly under the toolbar's first one. Opening or closing a bar no longer moves the page under the pointer.
- **Labels centered by their letters**: "Done" sat about a pixel low in its button, because a line of text has more room above its letters than below. Labels are now centered by their capital letters, and the same was checked and fixed in the page number, the zoom and size menus, the menus, the messages at the bottom, the banner and the buttons of the popups, by measuring the rendered pixels. Three icons that were half a pixel off center were redrawn.
- **White** and **brown** join the preset colors of the color picker, now two even rows of six; it remembers six recent colors.

## 0.6.0 — 2026-11-11

- **Text boxes**: the new **T** button in the toolbar (or *Toggle Adding Text*) turns on text mode, with its own row of tools: font size, bold, italic, underline, alignment (left, center, right, justify) and color.
  - Click on a page and type: the box grows with its text and wraps at the page's edge. Drag across the page instead to set the width first. Ctrl+B, Ctrl+I and Ctrl+U work while typing; Esc, Ctrl+Enter or a click elsewhere ends it.
  - In text mode, click a box to type in it where you click, or drag it to move it. With text mode off, click a box to select it: its bar changes the style, edits (also Enter or a double click) or deletes it (also Delete). A selected box has side handles to make it wider or narrower.
  - Everything can be undone with Ctrl+Z, like drawings. The list has a **Text boxes** section, and *Delete All Text Boxes for This File* deletes them all after asking.
  - Downloads include them as free text annotations with the lines shown on screen, in Helvetica, with their size, style, alignment and color, also on pages turned by /Rotate. Characters Helvetica's standard set lacks become "?", and the download's message says how many.
- **Color picker** for drawings and text: one color button instead of six ink chips. It offers ten colors (black, gray, red, orange, yellow, green, teal, blue, purple and pink), your recent colors, and any other color through a saturation/brightness square, a hue slider or a hex code. A selected drawing shows each color as you drag; the one you settle on is one undo step. On dark pages a dark color is drawn lighter, so it stays visible; downloads use the color you picked.
- **A cleaner toolbar and drawing bar**: every button is the same size, groups are the same distance apart, and the dividers have the same space on both sides (and no longer end a row when the toolbar wraps). The drawing and text bars have no divider lines, so nothing in them can look misaligned with the toolbar above; their controls start at the same place, and **Done** is a compact button flush with the toolbar's right edge, its check mark and label centered. The eraser now sits with the other tools.
- The Draw button has a pencil icon with a band in the current ink, like the highlighter's band; the new T button shows the text color the same way.
- Leaving draw or text mode leaves nothing selected.

## 0.5.0 — 2026-11-10

- **Drawing**: the new 🖋 **Draw** button in the toolbar turns on draw mode, with a second row of tools under the toolbar: pen, line, arrow, rectangle, ellipse and eraser, six inks and three widths.
  - Draw anywhere on a page: over text, pictures, tables, margins and other annotations, in Markdown, text and PDF files, at any zoom, with a mouse, a pen or touch. On dark pages each ink turns lighter (black ink shows up light).
  - Shift keeps lines and arrows to 15° steps and makes squares and circles. P, L, A, R, O and E pick the tools; Esc cancels the shape being drawn, or stops drawing.
  - With drawing off, click a drawing to select it: change its ink or width, drag it to move it on its page, or delete it (also with Delete or Backspace). The eraser dims what it will delete; one eraser drag is one undo step.
  - Everything can be undone with Ctrl+Z. The last tool, ink and width are remembered for all files.
- The list is now **Annotations**, with a **Drawings** section: a small picture of each drawing, go to it, delete it, or delete them all. New commands: *Toggle Drawing* and *Delete All Drawings for This File* (it asks first, and Ctrl+Z brings them back). *Toggle Highlights List* is now *Toggle Annotations List*.
- **Downloads** include drawings as standard PDF annotations: ink, line (with an open arrowhead for arrows), square and circle, each drawn exactly as on screen, in the light-page ink. The second option is now *Download PDF without Annotations*, and a downloaded PDF file is named `… (annotated).pdf`.
- Drawings are stored in their own file next to each document's record (`<hash>.drawings.json`), so going back to 0.4 cannot erase them. They follow file and folder renames, come along with *Reattach Highlights*, and merge across VS Code windows like highlights.
- The highlight tool has a new **highlighter** icon whose band shows the current highlight color, so it can't be mistaken for drawing. The highlight tool, drawing and placing the reading marker now turn each other off.
- Reading sounds: the animated bars show only next to the recording that plays, no longer on its tile as well.

## 0.4.0 — 2026-11-10

- **Ten built-in reading sounds**, five rains and five fireplaces: public-domain (CC0) recordings from Freesound, credited in the README. The loops are now part of the repository and of every package.
  - The panel has a tile per kind of sound (**Rain**, **Fireplace**, **Custom**) and lists the recordings of the chosen kind. Each kind remembers its recording: by default *Half-open window* for rain and *Home fireplace* for the fireplace.
  - Hovering over a recording shows what it sounds like and who recorded it.
- **Your own sounds** (**Custom**): add MP3, Ogg Vorbis, WAV or FLAC files with **Add sound files…** in the panel or the new command *Add Reading Sounds from Files…*. They loop like the built-in sounds and play just as loud: the viewer measures each file's loudness when it is added (as EBU R 128 does) and evens it out, with a limiter for the peaks. Rename or remove them in the panel. The extension keeps copies in its storage folder, shared by all windows.
- The player now has a few interchangeable slots, all unlocked at your first click in the viewer, so any sound (including one added later) starts and loops without another click. Switching quickly between sounds crossfades cleanly.
- What 0.3 remembered (rain or fireplace, and the volume) carries over.

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
  - The loops were built locally by `npm run sounds` and were not part of the repository; without them the button is hidden.
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
