// Message protocol between the extension host (PreviewPanel) and the viewer webview.
import type { CopyHint } from '../anchoring/diff';
import type { ResolvedPayload } from '../store/resolutions';
import type { HexColor, Ink } from './colors';
import type { DrawTool, Drawing, InkWidth, TextLayout, TextStyle } from './drawings';
import type { CustomSound, SoundRequest, SoundState } from './sounds';
import type { DocumentKind, Highlight, HighlightColor, PageRects, PageTheme, ReadingMarker, ZoomValue } from './types';

export interface ViewerInit {
  kind: DocumentKind;
  fileName: string;
  /** The document's URI (kept in the webview state so the panel can be restored). */
  uri: string;
  highlights: Highlight[];
  marker: ReadingMarker | null;
  drawings: Drawing[];
  zoom: ZoomValue;
  color: HighlightColor;
  theme: PageTheme;
  toolActive: boolean;
  listOpen: boolean;
  /** The last drawing tool, ink and width (shared by all files). Draw mode itself always starts off. */
  drawStyle: DrawStyle;
  /** Show how drawing works when draw mode first turns on (once per VS Code session). */
  drawHint: boolean;
  /** The style new text boxes get (the last one used, shared by all files). */
  textStyle: TextStyle;
  /** Show how adding text works when text mode first turns on (once per VS Code session). */
  textHint: boolean;
  /** Show how the eraser works when it first turns on (once per VS Code session). */
  eraseHint: boolean;
  /** Custom colors picked lately, newest first (shared by all files). */
  recentColors: HexColor[];
  fullView: boolean;
  /** Top and bottom page margins in PDF points; text inside them is header/footer and is not highlightable. */
  marginsPt: { top: number; bottom: number };
  sound: SoundState;
  /** The reader's own reading sounds. */
  customSounds: CustomSoundView[];
  /** The annotations were stored by a newer version: they are shown, and changes are not stored. */
  readOnly: boolean;
  /** Whether texts of earlier versions are kept on disk (the textSnapshots setting). */
  keepSnapshots: boolean;
  /** PDF files: signatures of the pages of the last version that was stored. */
  pages?: string[];
}

export interface DrawStyle {
  tool: DrawTool;
  color: Ink;
  width: InkWidth;
  /** The size of the eraser of draw mode. */
  eraserWidth: InkWidth;
}

/** A custom sound as a viewer sees it: with a URL it can load the file from. */
export interface CustomSoundView extends CustomSound {
  url: string;
}

export interface RenderWarning {
  message: string;
}

export type HostToViewer =
  | { type: 'init'; init: ViewerInit }
  | { type: 'rendering' }
  | {
      type: 'pdf';
      data: Uint8Array;
      renderId: number;
      theme: PageTheme;
      warnings: RenderWarning[];
      fromCache?: boolean;
      /** A render of unsaved text: what it does to the annotations is shown but not stored. */
      provisional?: boolean;
      /** Which of two identical neighboring blocks is the copy (from the editor's change events). */
      hints?: CopyHint[];
      /** Hashes of the earlier versions of the text that are kept on disk. */
      snapshots?: string[];
    }
  /** The texts of earlier versions the viewer asked for (those that are kept). */
  | { type: 'snapshots'; requestId: number; texts: Record<string, string> }
  | { type: 'renderError'; message: string; firstRender: boolean }
  | { type: 'zoom'; action: 'in' | 'out' }
  | { type: 'highlights'; highlights: Highlight[]; marker: ReadingMarker | null; drawings: Drawing[]; readOnly?: boolean; pages?: string[] }
  | { type: 'toggleList' }
  | { type: 'toggleTool' }
  | { type: 'toggleDrawing' }
  | { type: 'toggleText' }
  | { type: 'toggleRemove' }
  | { type: 'fullView'; full: boolean }
  | { type: 'theme'; theme: PageTheme }
  | { type: 'document'; fileName: string; uri: string }
  | { type: 'requestExport'; requestId: number }
  | { type: 'undo' }
  | { type: 'redo' }
  /** Delete every highlight (as one undoable step). */
  | { type: 'deleteAll' }
  /** Delete every drawing ('ink') or every text box ('text') as one undoable step; the reader already confirmed it. */
  | { type: 'deleteAllDrawings'; kind: 'ink' | 'text' }
  | { type: 'marker'; action: 'place' | 'goto' | 'remove' }
  /** Reading sounds changed (here or in another viewer). */
  | { type: 'sound'; state: SoundState }
  /** The custom sounds changed (added, renamed, removed or measured, here or in another viewer). */
  | { type: 'customSounds'; sounds: CustomSoundView[] }
  /** Sounds this viewer asked to add: measure their loudness, and show them if `reveal`. */
  | { type: 'soundsAdded'; ids: string[]; reveal: boolean };

export interface ExportHighlight {
  id: string;
  color: HighlightColor;
  text: string;
  note?: string;
  createdAt: string;
  pages: PageRects[];
}

export type ViewerCommand =
  | 'refresh'
  | 'toggleFullView'
  | 'download'
  /** Without any annotations (highlights, notes or drawings); the name predates drawings. */
  | 'downloadWithoutHighlights'
  | 'toggleTheme'
  | 'showLog'
  | 'showSource'
  /** Asks the reader to confirm, then deletes every drawing of the file. */
  | 'deleteAllDrawings'
  /** Asks the reader to confirm, then deletes every text box of the file. */
  | 'deleteAllTextBoxes';

export type ViewerToHost =
  | { type: 'ready' }
  | { type: 'focus'; focused: boolean }
  | { type: 'createHighlight'; highlight: Highlight }
  /** A new version of a highlight made by the reader: its quote rebased (Accept) or attached to other text. */
  | { type: 'replaceHighlight'; highlight: Highlight }
  /** `note: ''` removes the note. */
  | { type: 'updateHighlight'; id: string; color?: HighlightColor; note?: string }
  | { type: 'deleteHighlight'; id: string }
  | { type: 'setMarker'; marker: ReadingMarker | null }
  /** New drawings and text boxes, or new versions of existing ones (moved, edited, restyled, brought back by undo). */
  | { type: 'saveDrawings'; drawings: Drawing[] }
  | { type: 'deleteDrawings'; ids: string[] }
  | { type: 'drawStyleChanged'; style: Partial<DrawStyle> }
  | { type: 'drawHintShown' }
  | { type: 'textStyleChanged'; style: Partial<TextStyle> }
  | { type: 'textHintShown' }
  | { type: 'eraseHintShown' }
  | { type: 'recentColorsChanged'; colors: HexColor[] }
  /** Where everything is in a render (derived data: stored for saved renders only). */
  | ({ type: 'resolved'; renderId: number } & ResolvedPayload)
  /** Asks for the texts of earlier versions, to follow annotations by diff. */
  | { type: 'requestSnapshots'; requestId: number; hashes: string[] }
  /** The normalized text of a saved render in which annotations were found, to keep for later. */
  | { type: 'saveSnapshot'; renderId: number; hash: string; text: string }
  | { type: 'viewChanged'; zoom: ZoomValue }
  | { type: 'colorChanged'; color: HighlightColor }
  | { type: 'toolChanged'; active: boolean }
  | { type: 'listChanged'; open: boolean }
  | { type: 'openLink'; href: string }
  | { type: 'command'; command: ViewerCommand }
  | {
      type: 'exportData';
      requestId: number;
      /** The render the positions were computed for, and the hash of its text. */
      renderId: number;
      hash: string;
      highlights: ExportHighlight[];
      orphaned: number;
      /** How many of the orphaned highlights have a note. */
      orphanedNotes?: number;
      /** Drawings and text boxes left out because their content is not in this version. */
      orphanedDrawings?: number;
      /** Drawings and text boxes on pages the PDF has. */
      drawings: Drawing[];
      /** How the viewer laid out those text boxes (their lines as shown). */
      textLayouts?: TextLayout[];
      /** Drawings left out because their page is not in the PDF any more. */
      skippedDrawings: number;
      /** Password the reader typed to open an encrypted PDF (kept in memory only). */
      password?: string;
      error?: string;
    }
  | { type: 'copyText'; text: string }
  | ({ type: 'sound' } & SoundRequest)
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** State kept by the webview through `vscode.setState`, used to restore panels after a restart. */
export interface WebviewPersistedState {
  uri: string;
  pageNumber?: number;
  fraction?: number;
}
