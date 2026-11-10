// Reading sounds: looping ambient recordings the viewer can play while you read.
//  - Built-in: public-domain (CC0) recordings from Freesound, made into seamless loops by
//    scripts/fetch-sounds.mjs (media/sounds/, copied to dist/webview/sounds/ by the build).
//  - Custom: audio files the reader adds. The extension keeps a copy in its global storage and
//    evens out its loudness to match the built-in loops (measured by a viewer, see webview/loudness.ts).
// Sounds come in categories; each category remembers which of its recordings its tile plays.

export type SoundCategory = 'rain' | 'fireplace' | 'custom';
export type BuiltInCategory = Exclude<SoundCategory, 'custom'>;

export const SOUND_CATEGORIES: readonly SoundCategory[] = ['rain', 'fireplace', 'custom'];

export const CATEGORY_LABELS: Readonly<Record<SoundCategory, string>> = {
  rain: 'Rain',
  fireplace: 'Fireplace',
  custom: 'Custom',
};

export interface BuiltInSound {
  id: string;
  category: BuiltInCategory;
  name: string;
  /** What it sounds like, in a line. */
  description: string;
  /** File name in dist/webview/sounds/. */
  file: string;
  /** The recording on Freesound it was cut from (Creative Commons 0). */
  credit: { title: string; author: string; url: string };
}

/** In the order the panel lists them; the first of each category is its default. */
export const BUILT_IN_SOUNDS: readonly BuiltInSound[] = [
  {
    id: 'rain-half-open-window',
    category: 'rain',
    name: 'Half-open window',
    description: 'Rain on walls and windows, with drops falling through an open window. Close and detailed.',
    file: 'rain-half-open-window.ogg',
    credit: { title: 'Rain from Half Open Window 1.aif', author: 'RutgerMuller', url: 'https://freesound.org/people/RutgerMuller/sounds/158690/' },
  },
  {
    id: 'rain-mountain-downpour',
    category: 'rain',
    name: 'Mountain downpour',
    description: 'Heavy, even rain outdoors, like soft white noise. The steadiest of them all.',
    file: 'rain-mountain-downpour.ogg',
    credit: { title: 'Rain_in_Albanian_Mountains_White_Noise', author: 'SignatureSoundsOrg', url: 'https://freesound.org/people/SignatureSoundsOrg/sounds/872734/' },
  },
  {
    id: 'rain-hotel-window',
    category: 'rain',
    name: 'Hotel window at night',
    description: 'Rain heard from inside, against a window: softer and lower, with drops drumming on the glass.',
    file: 'rain-hotel-window.ogg',
    credit: { title: 'Dharamshala Rain', author: 'AugustSandberg', url: 'https://freesound.org/people/AugustSandberg/sounds/508527/' },
  },
  {
    id: 'rain-roof-window',
    category: 'rain',
    name: 'Roof window',
    description: 'Rain on a window in the roof of a house.',
    file: 'rain-roof-window.ogg',
    credit: { title: 'Rain on the House Roof Window #001', author: 'bassimat', url: 'https://freesound.org/people/bassimat/sounds/833924/' },
  },
  {
    id: 'rain-countryside',
    category: 'rain',
    name: 'Heavy rain, countryside',
    description: 'Strong rain in open country, nothing else around. Mono, so it sounds centered rather than wide.',
    file: 'rain-countryside.ogg',
    credit: { title: 'Rain heavy 1 (rural)', author: 'jmbphilmes', url: 'https://freesound.org/people/jmbphilmes/sounds/200270/' },
  },
  {
    id: 'fire-home-fireplace',
    category: 'fireplace',
    name: 'Home fireplace',
    description: 'A full, warm roar with crackles all through.',
    file: 'fire-home-fireplace.ogg',
    credit: { title: 'Fireplace.wav', author: 'inchadney', url: 'https://freesound.org/people/inchadney/sounds/132534/' },
  },
  {
    id: 'fire-close-fireplace',
    category: 'fireplace',
    name: 'Close fireplace',
    description: 'A close, warm fire with steady crackling and a few louder pops.',
    file: 'fire-close-fireplace.ogg',
    credit: { title: 'Fireplace for Six Minutes (Stereo)', author: 'petebuchwald', url: 'https://freesound.org/people/petebuchwald/sounds/496130/' },
  },
  {
    id: 'fire-living-room',
    category: 'fireplace',
    name: 'Living room fireplace',
    description: 'A medium fire with more crackle and less roar.',
    file: 'fire-living-room.ogg',
    credit: {
      title: 'Aachen_Burning Fireplace Crackling Fire Sounds.wav',
      author: 'visionear',
      url: 'https://freesound.org/people/visionear/sounds/501417/',
    },
  },
  {
    id: 'fire-log-cabin',
    category: 'fireplace',
    name: 'Log cabin (binaural)',
    description: 'A close fire in a small log cabin, recorded binaurally: on headphones it sounds like sitting in front of it.',
    file: 'fire-log-cabin.ogg',
    credit: { title: '(binaural) fire crackling', author: 'yfjesse', url: 'https://freesound.org/people/yfjesse/sounds/734248/' },
  },
  {
    id: 'fire-wet-log',
    category: 'fireplace',
    name: 'Small fire, wet log',
    description: 'A small fire in a room, with the hiss of a wet log and scattered pops.',
    file: 'fire-wet-log.ogg',
    credit: { title: 'fireplace-jim.aif', author: 'hovercraft', url: 'https://freesound.org/people/hovercraft/sounds/66412/' },
  },
];

/** Integrated loudness of every built-in loop (LUFS); custom sounds are brought to it too. */
export const TARGET_LOUDNESS = -16;
/** How far a custom sound's level may be changed to match (dB). */
export const MIN_CUSTOM_GAIN_DB = -20;
export const MAX_CUSTOM_GAIN_DB = 24;

/** A sound the reader added (its file is a copy in the extension's storage). */
export interface CustomSound {
  id: string;
  name: string;
  /** Gain (dB) that brings it to TARGET_LOUDNESS; missing until a viewer has measured it. */
  gainDb?: number;
}

/** Custom sound ids look like `custom-3f9k2a7q`. */
export const CUSTOM_ID_PATTERN = /^custom-[a-z0-9]{4,32}$/;

export function isCustomId(id: unknown): id is string {
  return typeof id === 'string' && CUSTOM_ID_PATTERN.test(id);
}

export function builtInSound(id: unknown): BuiltInSound | undefined {
  return BUILT_IN_SOUNDS.find((s) => s.id === id);
}

export function categoryOf(id: string): SoundCategory | undefined {
  return builtInSound(id)?.category ?? (isCustomId(id) ? 'custom' : undefined);
}

/** For each category, the recording its tile plays (none for an empty custom category). */
export type SoundChoices = Record<SoundCategory, string | undefined>;

export const DEFAULT_CHOICES: Readonly<SoundChoices> = {
  rain: 'rain-half-open-window',
  fireplace: 'fire-home-fireplace',
  custom: undefined,
};

export const DEFAULT_SOUND = 'rain-half-open-window';
/** Slider position (0–1) used until the reader picks a volume. */
export const DEFAULT_VOLUME = 0.7;

/** Sound ids of 0.3 (one recording per category), as saved in the extension's state. */
const LEGACY_IDS: Readonly<Record<string, string>> = { rain: 'rain-half-open-window', fireplace: 'fire-home-fireplace' };

/** A saved sound id in today's terms: 0.3's ids become their category's default. */
export function migrateSoundId(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;
  return LEGACY_IDS[id] ?? id;
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

export function clampGainDb(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_CUSTOM_GAIN_DB, Math.max(MIN_CUSTOM_GAIN_DB, value));
}

/** What every viewer shows: the chosen sound, the volume, and whether it is playing. */
export interface SoundState {
  /** The sound that plays (or would play: play resumes it). */
  sound: string;
  /** For each category, the recording its tile plays. */
  choices: SoundChoices;
  volume: number;
  playing: boolean;
  /** This viewer produces the audio. Only one viewer plays at a time; the others just show it. */
  owner: boolean;
}

/** File types a custom sound may have: what VS Code's webviews can decode (no Opus, no AAC). */
export const CUSTOM_SOUND_EXTENSIONS: readonly string[] = ['mp3', 'ogg', 'oga', 'wav', 'flac'];

/** What a viewer asks the extension for. */
export type SoundRequest =
  /** Play this sound (it becomes its category's choice). */
  | { action: 'play'; sound: string }
  | { action: 'pause' }
  | { action: 'volume'; volume: number }
  /**
   * The reader clicked or typed in this viewer, so it may now start sound on its own. VS Code lets a
   * webview make sound only after a click in it; until then a viewer asked to play waits for one.
   */
  | { action: 'ready' }
  /** The viewer that was asked to play could not (missing or broken file…). */
  | { action: 'failed'; sound: string; message: string }
  /** The panel opened: re-read the custom sounds (another VS Code window may have changed them). */
  | { action: 'refresh' }
  /** Pick audio files and add them as custom sounds. */
  | { action: 'add' }
  | { action: 'rename'; sound: string; name: string }
  | { action: 'remove'; sound: string }
  /** The gain that matches a custom sound's loudness to the built-in ones. */
  | { action: 'measured'; sound: string; gainDb: number }
  /** A custom sound's file cannot be decoded here (wrong format…). */
  | { action: 'unplayable'; sound: string; message: string };
