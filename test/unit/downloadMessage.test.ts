// What the message after a download says (H2, E13): nothing that was left out goes unsaid.
import { describe, expect, it } from 'vitest';
import { downloadMessage, downloadNotes, type DownloadCounts } from '../../src/export/summary';

const none: DownloadCounts = {
  withAnnotations: true,
  highlights: 0,
  drawings: 0,
  textBoxes: 0,
  orphanedHighlights: 0,
  orphanedNotes: 0,
  orphanedDrawings: 0,
  drawingsWithoutPage: 0,
  replacedChars: 0,
  decrypted: false,
};

describe('the download message', () => {
  it('says what is in the file', () => {
    expect(downloadMessage('notes.pdf', { ...none, highlights: 3, drawings: 1, textBoxes: 2 })).toBe('Saved notes.pdf (3 highlights, 1 drawing and 2 text boxes included).');
    expect(downloadMessage('notes.pdf', { ...none, highlights: 1 })).toBe('Saved notes.pdf (1 highlight and 0 drawings included).');
    expect(downloadMessage('notes.pdf', { ...none, withAnnotations: false })).toBe('Saved notes.pdf (without annotations).');
  });

  it('H2: counts orphaned highlights, and how many of them have a note', () => {
    expect(downloadNotes({ ...none, highlights: 2, orphanedHighlights: 1 })[1]).toBe('1 orphaned highlight was left out: its text is not in this version');
    expect(downloadNotes({ ...none, highlights: 2, orphanedHighlights: 1, orphanedNotes: 1 })[1]).toBe('1 orphaned highlight was left out (1 with a note): its text is not in this version');
    expect(downloadNotes({ ...none, orphanedHighlights: 4, orphanedNotes: 2 })[1]).toBe('4 orphaned highlights were left out (2 with a note): their text is not in this version');
  });

  it('E13: counts drawings and text boxes left out because their content is gone, or their page', () => {
    expect(downloadNotes({ ...none, orphanedDrawings: 1 })[1]).toBe('1 drawing or text box was left out: what it was on is not in this version');
    expect(downloadNotes({ ...none, orphanedDrawings: 3 })[1]).toBe('3 drawings or text boxes were left out: what they were on is not in this version');
    expect(downloadNotes({ ...none, drawingsWithoutPage: 2 })[1]).toBe('2 drawings on pages the document no longer has were left out');
  });

  it('puts everything in one sentence, in a fixed order', () => {
    const message = downloadMessage('a.pdf', { ...none, highlights: 1, drawings: 2, orphanedHighlights: 1, orphanedDrawings: 1, replacedChars: 1, decrypted: true });
    expect(message).toBe(
      'Saved a.pdf (1 highlight and 2 drawings included; 1 orphaned highlight was left out: its text is not in this version; ' +
        '1 drawing or text box was left out: what it was on is not in this version; ' +
        '1 character in text boxes is not in the PDF\'s standard font and shows as "?"; the copy is not password-protected).',
    );
  });
});
