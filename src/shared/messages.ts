// Message protocol between the extension host (PreviewPanel) and the viewer webview.
import type { SoundRequest, SoundState } from './sounds';
import type {
  DocumentKind,
  Highlight,
  HighlightColor,
  HighlightStatus,
  PageRects,
  PageTheme,
  ReadingMarker,
  ZoomValue,
} from './types';

export interface ViewerInit {
  kind: DocumentKind;
  fileName: string;
  /** The document's URI (kept in the webview state so the panel can be restored). */
  uri: string;
  highlights: Highlight[];
  marker: ReadingMarker | null;
  zoom: ZoomValue;
  color: HighlightColor;
  theme: PageTheme;
  toolActive: boolean;
  listOpen: boolean;
  fullView: boolean;
  /** Top and bottom page margins in PDF points; text inside them is header/footer and is not highlightable. */
  marginsPt: { top: number; bottom: number };
  sound: SoundState;
}

export interface RenderWarning {
  message: string;
}

export type HostToViewer =
  | { type: 'init'; init: ViewerInit }
  | { type: 'rendering' }
  | { type: 'pdf'; data: Uint8Array; renderId: number; theme: PageTheme; warnings: RenderWarning[]; fromCache?: boolean }
  | { type: 'renderError'; message: string; firstRender: boolean }
  | { type: 'zoom'; action: 'in' | 'out' | 'reset' }
  | { type: 'highlights'; highlights: Highlight[]; marker: ReadingMarker | null }
  | { type: 'toggleList' }
  | { type: 'toggleTool' }
  | { type: 'fullView'; full: boolean }
  | { type: 'theme'; theme: PageTheme }
  | { type: 'document'; fileName: string; uri: string }
  | { type: 'requestExport'; requestId: number }
  | { type: 'undo' }
  | { type: 'redo' }
  /** Delete every highlight (as one undoable step). */
  | { type: 'deleteAll' }
  | { type: 'marker'; action: 'place' | 'goto' | 'remove' }
  /** Reading sounds changed (here or in another viewer). */
  | { type: 'sound'; state: SoundState };

export interface AnchorResult {
  id: string;
  status: HighlightStatus;
  start?: number;
  end?: number;
  pages?: PageRects[];
  textModelHash?: string;
}

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
  | 'downloadWithoutHighlights'
  | 'toggleTheme'
  | 'showLog'
  | 'showSource';

export type ViewerToHost =
  | { type: 'ready' }
  | { type: 'focus'; focused: boolean }
  | { type: 'createHighlight'; highlight: Highlight }
  /** `note: ''` removes the note. */
  | { type: 'updateHighlight'; id: string; color?: HighlightColor; note?: string }
  | { type: 'deleteHighlight'; id: string }
  | { type: 'setMarker'; marker: ReadingMarker | null }
  | { type: 'anchorsResolved'; renderId: number; results: AnchorResult[] }
  | { type: 'viewChanged'; zoom: ZoomValue }
  | { type: 'colorChanged'; color: HighlightColor }
  | { type: 'toolChanged'; active: boolean }
  | { type: 'listChanged'; open: boolean }
  | { type: 'openLink'; href: string }
  | { type: 'command'; command: ViewerCommand }
  | {
      type: 'exportData';
      requestId: number;
      highlights: ExportHighlight[];
      orphaned: number;
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
