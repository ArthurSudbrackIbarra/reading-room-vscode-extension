// What the message after a download says: what went into the file and what was left out, and why.
// No vscode and no file access here, so the wording can be tested.

export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** "a", "a and b", "a, b and c". */
export function listOf(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface DownloadCounts {
  withAnnotations: boolean;
  /** Highlights, ink drawings and text boxes written to the file. */
  highlights: number;
  drawings: number;
  textBoxes: number;
  /** Orphaned highlights (their text is not in this version), and how many of them carry a note. */
  orphanedHighlights: number;
  orphanedNotes: number;
  /** Drawings and text boxes whose content is not in this version. */
  orphanedDrawings: number;
  /** Drawings stored for a page the document does not have. */
  drawingsWithoutPage: number;
  /** Characters of text boxes that the PDF's standard font cannot show. */
  replacedChars: number;
  decrypted: boolean;
}

/** The parts of the message, in the order they are shown. Nothing that was left out goes unsaid. */
export function downloadNotes(c: DownloadCounts): string[] {
  const included = [count(c.highlights, 'highlight'), count(c.drawings, 'drawing'), c.textBoxes > 0 ? count(c.textBoxes, 'text box', 'text boxes') : ''].filter(Boolean);
  const one = (n: number) => n === 1;
  return [
    c.withAnnotations ? `${listOf(included)} included` : 'without annotations',
    c.orphanedHighlights > 0
      ? `${c.orphanedHighlights} orphaned highlight${one(c.orphanedHighlights) ? ' was' : 's were'} left out${c.orphanedNotes > 0 ? ` (${c.orphanedNotes} with a note)` : ''}: ${one(c.orphanedHighlights) ? 'its' : 'their'} text is not in this version`
      : '',
    c.orphanedDrawings > 0
      ? `${count(c.orphanedDrawings, 'drawing or text box', 'drawings or text boxes')} ${one(c.orphanedDrawings) ? 'was' : 'were'} left out: what ${one(c.orphanedDrawings) ? 'it was' : 'they were'} on is not in this version`
      : '',
    c.drawingsWithoutPage > 0 ? `${count(c.drawingsWithoutPage, 'drawing')} on pages the document no longer has ${one(c.drawingsWithoutPage) ? 'was' : 'were'} left out` : '',
    c.replacedChars > 0
      ? `${count(c.replacedChars, 'character')} in text boxes ${one(c.replacedChars) ? 'is' : 'are'} not in the PDF's standard font and ${one(c.replacedChars) ? 'shows' : 'show'} as "?"`
      : '',
    c.decrypted ? 'the copy is not password-protected' : '',
  ].filter(Boolean);
}

export function downloadMessage(fileName: string, c: DownloadCounts): string {
  return `Saved ${fileName} (${downloadNotes(c).join('; ')}).`;
}
