# Reading Room

**A quiet place to read and study inside VS Code.** Open PDF, Markdown and plain text files as pages, highlight what matters, write notes next to it, draw and type on the page, mark where you stopped, and read to the sound of rain, a crackling fireplace or your own recordings.

![A Markdown file next to its pages in Reading Room: highlights in four colors, two notes, three drawings (a purple underline, a blue arrow and a red ellipse), a blue text box at the tail of the arrow, the red reading marker and the list of annotations](docs/demo.png)

## What you can do

**Read**

- **PDF files** open as they are, including password-protected ones.
- **Markdown and `.txt` files** become print-quality pages: clickable links, an outline, syntax-highlighted code, math and diagrams. They are converted again when you save.
- Zoom freely (toolbar, `Ctrl`+wheel, pinch) and switch the pages to a **dark theme**.

**Study**

- **Highlight** text in five colors and write a **note** on any highlight.
- **Draw** anywhere on a page: pen strokes, lines, arrows, rectangles and ellipses, in any color and three widths.
- **Type** anywhere on a page: text boxes in any color and size, with bold, italic and underline on any part of the text.
- **Take things back**: an undo button and `Ctrl+Z`, a remove tool that deletes whole annotations with a click, and an eraser that rubs out part of a drawing.
- **Your annotations stay on their content** when the file changes. They follow the words (or the picture) they are on through your edits. If that content is deleted they are kept and listed, and they return when it does.
- A side list shows every highlight, note, drawing and text box; click one to jump to it.

**Keep your place**

- Mark **where you stopped reading**. The document opens right there next time.

**Stay focused**

- **Reading sounds**: ten recordings of rain and fireplaces, or your own audio files, looping for as long as you read.

**Take it with you**

- **Download** a PDF with your highlights, notes, drawings and text boxes as standard PDF annotations. Acrobat, Edge, Chrome, Firefox and Preview all show them.

**Your files are left alone**

- Reading Room never changes your documents and never creates files in your folders. Everything you add is stored in VS Code's own storage for the extension. The only file it writes elsewhere is a PDF you download, where you choose.

## Contents

- [Getting started](#getting-started)
- [The toolbar](#the-toolbar)
- [Highlights and notes](#highlights-and-notes)
- [Drawing](#drawing)
- [Text boxes](#text-boxes)
- [Removing and undoing](#removing-and-undoing)
- [When the document changes](#when-the-document-changes)
- [Where you stopped reading](#where-you-stopped-reading)
- [Reading sounds](#reading-sounds)
- [Dark pages](#dark-pages)
- [Download](#download)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings](#settings)
- [Your data](#your-data)
- [What Markdown and text files look like](#what-markdown-and-text-files-look-like)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Credits](#credits)

## Getting started

| To read | Do this | It opens |
| --- | --- | --- |
| A **PDF file** | Open it (Explorer, `Ctrl+P`, …) | In Reading Room, as the file's editor |
| A **Markdown or `.txt` file** | Click the **book button** in the editor title bar (top right) | To the side of the editor |
| | **Alt+click** the same button | In the current editor group, full width |
| | `Ctrl+K Shift+R`, or **Open in Reading Room to the Side** in the Command Palette | To the side |
| | `Ctrl+Shift+Alt+R`, or **Open in Reading Room** | In the current group |
| Any of them | Right-click the file in the Explorer → **Open in Reading Room to the Side** | To the side |

**Markdown and text files need a browser.** Their pages are made with Google Chrome, Microsoft Edge, Chromium or Brave, whichever is installed. If none is, Reading Room asks before downloading a small Chromium (about 126 MB) into its own storage. PDF files need nothing.

**Another PDF extension installed?** VS Code asks once which one should open PDF files. Choose **Keep Reading Room**. To change it later, right-click a PDF tab → **Reopen Editor With…** → **Configure default editor for '\*.pdf'…**.

Good to know:

- Each file has one Reading Room tab; opening it again brings that tab forward.
- A Markdown or text file is converted again when you **save** it, and you stay where you were. **Refresh** also shows unsaved changes.
- A PDF file is reloaded when it changes on disk.

## The toolbar

| Control | What it does |
| --- | --- |
| ☰ | Show or hide the list of annotations: the reading position, highlights with their notes, drawings and text boxes |
| ↑ ↓, page box | Previous and next page, go to a page |
| − / zoom list / + | Zoom out, choose a zoom (Fit Width, Fit Page, Actual Size, 50 %–400 %), zoom in |
| Highlighter | **Highlight tool**: while it is on, every text selection becomes a highlight. The band under the icon shows the current color |
| ● ● ● ● ● | Highlight color: yellow, pink, green, blue, orange |
| Pencil | **Draw mode**: a second row of drawing tools appears (see [Drawing](#drawing)). The band shows the current ink |
| T | **Text mode**: a second row of text tools appears (see [Text boxes](#text-boxes)). The band shows the color new text gets |
| Pointer with × | **Remove tool**: a click deletes the highlight, drawing or text box under the pointer; a drag deletes everything it goes over |
| 🔖 ▾ | **Reading marker**: click, then click the line where you stopped. The menu also has _Go to_ and _Remove_ |
| ↶ | **Undo** the last change. Its tooltip says what it will take back |
| 🎧 | **Reading sounds**: play rain, a fireplace or your own sounds |
| ◐ | **Light or dark pages** |
| ⟳ | Convert again (Markdown, text) or reload from disk (PDF) |
| ⤢ | **Full view** (Markdown, text): move the pages between "next to the source" and "in the source's editor group" |
| ⤓ ▾ | Download a PDF, with your annotations (the default) or without |

What is switched on, and what is picked in the second row (the tool, the width, the alignment), is marked in blue. The highlight tool, draw mode, text mode, the remove tool and placing the reading marker exclude each other: turning one on turns the others off.

## Highlights and notes

- **Highlight tool on**: select text, and it is highlighted in the current color.
- **Highlight tool off**: select text and a small bar appears next to the selection. Pick a color, use 💬 to highlight and write a note right away, or 🔖 to mark that line as your reading position.
- **Click a highlight** to change its color, add or edit its note, copy its text or delete it. While its bar is open, **Delete** deletes it and **Enter** opens its note.
- **Notes**: type, then press **Ctrl+Enter** or click **Save**. Clicking elsewhere also saves; **Esc** cancels. Highlights with a note have a darker underline and a 💬 badge in the right margin; hover to read the note.
- The **☰ list** shows your reading position at the top, then all highlights in document order with their notes, then your drawings and text boxes. Click one to jump to it.

## Drawing

Circle a figure, underline a line, point at something with an arrow, scribble in the margin. Drawing works on any page: over text, pictures, tables and empty space, on light and dark pages, at any zoom, with mouse, pen and touch.

Click the pencil in the toolbar. A second row appears, starting with the words **DRAW MODE**, and every drag on a page draws:

<img src="docs/drawing-bar.png" alt="The toolbar with draw mode on: the pencil button is marked in blue. Below it, the drawing bar: the words DRAW MODE, the tools (pen, line, arrow, rectangle, ellipse, eraser) with the pen marked in blue, the ink color, three widths and a Done button on the right" width="870">

| Tool | Key | Draws | With Shift |
| --- | --- | --- | --- |
| Pen | `P` | A smoothed line that follows the pointer. A click leaves a dot | |
| Line | `L` | A straight line | The angle snaps to 15° steps |
| Arrow | `A` | A line with an arrowhead at the end | The angle snaps to 15° steps |
| Rectangle | `R` | The outline of the box you drag | A square |
| Ellipse | `O` | An ellipse inside the box you drag | A circle |
| Eraser | `E` | Rubs out the part of a drawing it goes over, like an eraser on paper | |

- **Ink**: the colored dot opens the color picker. Pick one of twelve colors, one of your recent colors, or any color (drag in the square and along the rainbow, or type a hex code).
- **Width**: thin, medium or thick.
- **Eraser**: a ring follows the pointer and shows exactly what will be rubbed out, also while you drag. With the eraser picked, the three widths become its three **sizes** (small, medium, large), and the ring grows with them. Drag across a line to cut it in two, along it to shorten it.
- **Stop drawing** with **Esc**, **Done** or the pencil. Esc while dragging cancels only that shape.

<img src="docs/color-picker.png" alt="The color picker: twelve colors in two rows of six, red picked; below, a saturation and brightness square, a rainbow hue slider and the hex code #D1242F" width="208">

**Change a drawing** (with draw mode off): click its line. It gets a dashed outline and a small bar to pick another ink or width, to choose what it follows, or to delete it. Drag a selected drawing to move it.

## Text boxes

Write a word in the margin, label an arrow, add a correction. Click **T** in the toolbar. A second row appears, starting with the words **TEXT MODE**:

<img src="docs/text-bar.png" alt="The toolbar with text mode on: the T button is marked in blue. Below it, the text bar: the words TEXT MODE, the font size, bold, italic and underline, the four alignments with left marked in blue, the text color and a Done button on the right" width="870">

- **Click** on a page and type. The box grows as you type; **Enter** starts a new line.
- **Drag** across a page instead to choose the box's width first: the text wraps inside it.
- **Size, alignment and color** apply to the whole box.
- **Bold, italic and underline** go where you want them: select part of the text and click **B**, _I_ or U, or press `Ctrl+B`, `Ctrl+I`, `Ctrl+U`.
- **Esc**, `Ctrl+Enter` or a click elsewhere ends typing. **Esc** again, **Done** or **T** leaves text mode.

**Change a text box**: in text mode, click its text to type in it, or drag it to move it. With text mode off, click a box to select it: a small bar changes its color, size, alignment and style, edits it (**Enter** or a double click) or deletes it. Drag a handle on its side to make it wider or narrower.

## Removing and undoing

- **Undo**: the ↶ button in the toolbar, or `Ctrl+Z`, takes back the last change to your highlights, notes, drawings, text boxes and reading marker. `Ctrl+Y` or `Ctrl+Shift+Z` redoes it. While you type in a note or a text box, undo takes back the typing instead.
- **Remove tool** (the pointer with an ×): point at a highlight, drawing or text box and it fades, to show what a click would delete. Click to delete it, or drag to delete everything the pointer goes over. Each click or drag is one undo step. **Esc** leaves the tool.
- **Eraser** (in the drawing row): rubs out only the part of a drawing under its ring. It leaves highlights and text boxes alone.
- **Delete** or **Backspace** deletes whatever is selected.
- Deleting everything of one kind: the 🗑 next to **Drawings** or **Text boxes** in the ☰ list, or the commands **Delete All Highlights / Drawings / Text Boxes for This File**. They ask first, and undo brings everything back.

## When the document changes

Markdown and text files change while you read them: you edit them, a formatter rewraps them, `git checkout` swaps them. PDF files get replaced by new versions. Everything you added stays on its content:

| What changed | What happens |
| --- | --- |
| Text added or removed elsewhere, lines rewrapped, another page size | Everything stays on the same words, wherever they are now |
| Bold, links, heading levels and other formatting | Nothing changes |
| Words changed inside a highlight | It stays on the passage. The list shows **was … / now …**; ✓ keeps it on the text as it is now |
| The start or the end of a highlight deleted | It shrinks to what is left |
| All of its text deleted | It becomes **orphaned**: kept with its note and listed with the reason, not shown on the page |
| Its text replaced by other text | Orphaned, with a button to attach it to the text that took its place |
| The passage moved elsewhere | Everything moves with it |
| The file emptied, or replaced by another text | Everything is orphaned, nothing is deleted, and a banner says so |
| The text comes back (undo, `git checkout`, a restored file) | Everything returns to where it was, by itself |

- **Nothing is ever deleted automatically.** Orphaned annotations stay in the list until you delete them.
- **Drawings and text boxes** are attached to what they cover: the words under them, the line beside them, the picture they are on, or the page. The small bar of a selected drawing has a menu that says what it follows and lets you choose.
- **The reading marker** follows its line. When the line is deleted, the marker stands where the line was, with "You stopped about here".
- A message at the bottom says what a change did, only when something changed.

## Where you stopped reading

The reading marker is a red line with a bookmark tab. There is one per document.

- **Place it**: click 🔖 in the toolbar, then click a line. Or select some text and click 🔖 in the selection bar.
- **Next time you open the document**, Reading Room scrolls straight to the marker.
- **Move or remove it**: click its tab, use the 🔖 ▾ menu, or use the ☰ list.

## Reading sounds

<img src="docs/reading-sounds.png" alt="The reading sounds panel: Rain is chosen and the Half-open window recording plays, with four other rain recordings listed below it, a pause button and a volume slider at 70 %" width="328">

Click 🎧 in the toolbar:

- **Pick a kind of sound**: **Rain**, **Fireplace** or **Custom** (your own). It starts with a short fade-in.
- **Pick the recording** in the list below. Each kind remembers its choice.
- **Pause or play** with the round button and set the **volume** with the slider.
- The panel closes when you click elsewhere. The sound keeps playing until you pause it, also when you switch to another tab.

The sound never ends and never clicks, and all recordings are equally loud. One sound plays at a time, however many documents are open. The command **Reading Room: Play/Pause Reading Sounds** works from anywhere, and you can give it a shortcut.

**Your own sounds**: under **Custom**, **Add sound files…** adds MP3, Ogg Vorbis, WAV or FLAC files (up to 150 MB each). They loop like the built-in ones and play as loud. Reading Room keeps its own copy, so you can move or delete the original. Hover over a sound to rename or remove it.

## Dark pages

◐ switches all pages to a dark theme. Markdown and text files are converted again with dark colors. PDF files are inverted, keeping their hues; pictures keep their real colors. Downloads always use normal light pages.

## Download

**Download** opens a save dialog in your Downloads folder.

- **With annotations** (the default): highlights become PDF highlight annotations with their notes as comments, drawings become ink, line, square and circle annotations, and text boxes become free text annotations. Other PDF readers show them, and the ones that edit annotations can change them.
- **Without annotations** (in the ▾ menu) saves the plain PDF.
- Reading Room never overwrites the document you are viewing.
- A password-protected PDF is saved **without** its password when it is downloaded with annotations; the confirmation says so.

## Keyboard shortcuts

| Shortcut | What it does | When |
| --- | --- | --- |
| `Ctrl+K Shift+R` | Open in Reading Room to the Side | A Markdown or `.txt` editor is focused |
| `Ctrl+Shift+Alt+R` | Open in Reading Room (current group) | A Markdown or `.txt` editor is focused |
| `Ctrl+Z` | Undo | Reading Room is focused |
| `Ctrl+Y`, `Ctrl+Shift+Z` | Redo | Reading Room is focused |
| `Delete`, `Backspace` | Delete what is selected | Something is selected |
| `Enter` | Edit what is selected: type in the text box, write the highlight's note | A text box or a highlight is selected |
| `Ctrl+Enter` | Save the note; stop typing in a text box | Writing a note or typing in a text box |
| `Esc` | Cancel what is in progress; otherwise leave the mode, close popups, deselect | Reading Room is focused |
| `P`, `L`, `A`, `R`, `O`, `E` | Pen, Line, Arrow, Rectangle, Ellipse, Eraser | Draw mode is on |
| `Shift` (held) | Lines and arrows in 15° steps; squares and circles | Drawing a shape |
| `Ctrl+B`, `Ctrl+I`, `Ctrl+U` | Bold, italic, underline | Typing in a text box |
| `Ctrl+=`, `Ctrl+Numpad+` | Zoom in | Reading Room is focused |
| `Ctrl+-`, `Ctrl+Numpad-` | Zoom out | Reading Room is focused |
| `Ctrl+Wheel`, pinch | Zoom around the pointer | Pointer over the pages |

On macOS, use `Cmd` instead of `Ctrl`.

All commands are in the Command Palette: type **Reading Room**. Commands without a shortcut (the modes, the reading marker, the sounds, downloads) can be given one in **Preferences: Open Keyboard Shortcuts**.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `readingRoom.defaultOpenMode` | `side` | What a plain click on the title-bar button does: `side` or `full` (Alt+click does the other) |
| `readingRoom.pageSize` | `A4` | `A4` or `Letter`, for Markdown and text files |
| `readingRoom.pageNumbers` | `true` | Print "n / N" at the bottom of each page |
| `readingRoom.renderOnSave` | `true` | Convert again when a Markdown or text file is saved |
| `readingRoom.allowRemoteImages` | `true` | Download `http(s)` images and show them on the pages |
| `readingRoom.cacheDays` | `7` | Days the pages of a Markdown or text file are kept after it was last opened, so it reopens instantly. `0` turns the cache off |
| `readingRoom.textSnapshots` | `true` | Keep a compressed copy of a document's text, so annotations can follow it exactly through changes. `false` deletes the copies; annotations are then found by searching for their text |
| `readingRoom.chromiumPath` | _(empty)_ | Path to a Chrome, Edge or Chromium executable; empty means detect one |
| `readingRoom.chromiumDownload` | `ask` | `ask`: offer to download Chromium when no browser is found; `never`: show an error instead |

The settings are the same in every workspace: workspace settings cannot change them.

## Your data

Highlights, notes, drawings, text boxes, reading positions and your own sounds live in VS Code's storage for this extension, never in your folders. **Reading Room: Reveal Annotation Data Folder** opens it.

- **Back up**: copy the `highlights` folder (and `sounds` for your own sounds). To restore, copy them back while VS Code is closed.
- **Renames**: when you rename or move a document inside VS Code, its annotations follow it. If you renamed it elsewhere, open the new file and run **Reading Room: Reattach Annotations from Another File…**.
- **Start over for one file**: the **Delete All …** commands (undo brings everything back).
- Annotations are kept per VS Code profile, and stay when the extension is uninstalled.
- For files you annotated, a compressed copy of their text is kept there too (see `readingRoom.textSnapshots`), and the pages of Markdown and text files are cached for a few days (**Reading Room: Clear Cached Pages** deletes them).

## What Markdown and text files look like

**Markdown**: headings (with an outline), tables, images (local, remote and SVG, all embedded), syntax-highlighted code, nested and task lists, blockquotes and GitHub alerts, footnotes, inline HTML, emoji shortcodes, **KaTeX** math and **Mermaid** diagrams. Links work: web links open your browser, `#heading` links jump within the document, and links to other files open them in VS Code. Images, diagrams and table rows are never split across pages.

**Plain text**: exactly as written, in a monospace font, with long lines wrapped. Web and mail addresses become clickable links.

## Troubleshooting

- **PDF files open in another viewer**: right-click the tab → **Reopen Editor With…** → **Reading Room**. **Configure default editor for '\*.pdf'…** in the same list makes it permanent.
- **"needs Chrome, Edge or Chromium"** (Markdown and text only): install one of them, choose a browser when asked, or let Reading Room download Chromium.
- **The browser cannot start** (some company policies block it): choose **Download Chromium** in the message, or set `readingRoom.chromiumPath` to another browser.
- **An image is missing**: the yellow banner and **Reading Room: Show Log** list every image that could not be loaded.
- **The pages look outdated**: press ⟳, or run **Reading Room: Clear Cached Pages**.
- **"Click anywhere in this viewer to start the sound"**: VS Code lets a tab play sound only after you have clicked or typed in it. One click and it plays.
- **"… can't be played in VS Code"**: the file's audio is in a format VS Code lacks (usually Opus or AAC). Convert it to MP3, Ogg Vorbis, WAV or FLAC.
- Anything else: run **Reading Room: Show Log**.

## Known limitations

- PDFs without a text layer (scanned pages) cannot be highlighted. Drawing, text boxes and the reading marker still work there.
- Annotations already inside a PDF are shown but cannot be edited.
- A drawing or text box cannot span two pages.
- Two identical passages cannot always be told apart: when an annotated paragraph is duplicated outside VS Code, its annotations may end up on the copy.
- Drawings on a formula or a diagram follow the nearest line of text or the diagram as a whole, not single symbols.
- A text box has one font, size, color and alignment. In downloads, characters outside Western European languages, and emoji, appear as "?" in text boxes (the download's message says how many).
- What the eraser leaves of a rectangle or an ellipse is a plain stroke.
- The undo history lasts while the tab is open.
- Reading sounds play only while a Reading Room tab is open.
- Renames done outside VS Code are not detected (use _Reattach Annotations_).

## Credits

The built-in reading sounds are loops cut from these recordings on [Freesound](https://freesound.org/), which their authors dedicated to the public domain ([Creative Commons 0](https://creativecommons.org/publicdomain/zero/1.0/)). Thank you for recording and sharing them.

| Sound | Recording | Recorded by |
| --- | --- | --- |
| Rain: Half-open window | [Rain from Half Open Window 1.aif](https://freesound.org/people/RutgerMuller/sounds/158690/) | RutgerMuller |
| Rain: Mountain downpour | [Rain_in_Albanian_Mountains_White_Noise](https://freesound.org/people/SignatureSoundsOrg/sounds/872734/) | SignatureSoundsOrg |
| Rain: Hotel window at night | [Dharamshala Rain](https://freesound.org/people/AugustSandberg/sounds/508527/) | AugustSandberg |
| Rain: Roof window | [Rain on the House Roof Window #001](https://freesound.org/people/bassimat/sounds/833924/) | bassimat |
| Rain: Heavy rain, countryside | [Rain heavy 1 (rural)](https://freesound.org/people/jmbphilmes/sounds/200270/) | jmbphilmes |
| Fireplace: Home fireplace | [Fireplace.wav](https://freesound.org/people/inchadney/sounds/132534/) | inchadney |
| Fireplace: Close fireplace | [Fireplace for Six Minutes (Stereo)](https://freesound.org/people/petebuchwald/sounds/496130/) | petebuchwald |
| Fireplace: Living room fireplace | [Aachen_Burning Fireplace Crackling Fire Sounds.wav](https://freesound.org/people/visionear/sounds/501417/) | visionear |
| Fireplace: Log cabin (binaural) | [(binaural) fire crackling](https://freesound.org/people/yfjesse/sounds/734248/) | yfjesse |
| Fireplace: Small fire, wet log | [fireplace-jim.aif](https://freesound.org/people/hovercraft/sounds/66412/) | hovercraft |

Reading Room is built on [PDF.js](https://mozilla.github.io/pdf.js/), [markdown-it](https://github.com/markdown-it/markdown-it), [Shiki](https://shiki.style/), [KaTeX](https://katex.org/), [Mermaid](https://mermaid.js.org/) and [pdf-lib](https://github.com/cantoo-scribe/pdf-lib). Icons are VS Code's [Codicons](https://github.com/microsoft/vscode-codicons), plus a few drawn for it.

Building it from source, how it works inside and the format of the stored files are described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
