// Reading sounds: looping ambient recordings the viewer can play while you read. The audio files
// are made by scripts/fetch-sounds.mjs (into media/sounds/) and copied to dist/webview/sounds/ by
// the build; a sound whose file is missing from the build is simply not offered.

export type SoundId = 'rain' | 'fireplace';

export interface SoundInfo {
  id: SoundId;
  label: string;
  /** File name in dist/webview/sounds/. */
  file: string;
}

export const SOUNDS: readonly SoundInfo[] = [
  { id: 'rain', label: 'Rain', file: 'rain.ogg' },
  { id: 'fireplace', label: 'Fireplace', file: 'fireplace.ogg' },
];

export const DEFAULT_SOUND: SoundId = 'rain';
/** Slider position (0–1) used until the reader picks a volume. */
export const DEFAULT_VOLUME = 0.7;

export function isSoundId(value: unknown): value is SoundId {
  return SOUNDS.some((s) => s.id === value);
}

export function soundLabel(id: SoundId): string {
  return SOUNDS.find((s) => s.id === id)?.label ?? id;
}

export function clampVolume(value: unknown, fallback = DEFAULT_VOLUME): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** Slider position to amplitude. Squared, so equal slider steps sound like similar loudness steps. */
export function volumeToGain(volume: number): number {
  const v = clampVolume(volume, 0);
  return v * v;
}

/** What every viewer shows: the chosen sound, the volume, and whether it is playing. */
export interface SoundState {
  sound: SoundId;
  volume: number;
  playing: boolean;
  /** This viewer produces the audio. Only one viewer plays at a time; the others just show it. */
  owner: boolean;
}

/** What a viewer asks the extension for. */
export type SoundRequest =
  | { action: 'play'; sound: SoundId }
  | { action: 'pause' }
  | { action: 'volume'; volume: number }
  /**
   * The reader clicked or typed in this viewer, so it may now start sound on its own. VS Code lets a
   * webview make sound only after a click in it; until then a viewer asked to play waits for one.
   */
  | { action: 'ready' }
  /** The viewer that was asked to play could not (missing or broken file…). */
  | { action: 'failed'; message: string };
