// How loud an audio file is, so the reader's own sounds play as loud as the built-in loops (which
// are made at TARGET_LOUDNESS). Integrated loudness as in ITU-R BS.1770 / EBU R 128 (what ffmpeg's
// ebur128 filter measures): K-weighting, 400 ms blocks every 100 ms, an absolute gate at -70 LUFS
// and a relative one 10 LU below. The math is plain TypeScript (unit-tested); decoding the file
// uses Web Audio.
import { MAX_CUSTOM_GAIN_DB, MIN_CUSTOM_GAIN_DB, TARGET_LOUDNESS } from '../src/shared/sounds';

/** Coefficients of one biquad filter section (a0 = 1). */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** BS.1770's K-weighting for a sample rate: a high shelf (+4 dB above ~1.7 kHz) and a high-pass at ~38 Hz (libebur128's design). */
export function kWeighting(rate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / rate);
  const vh = 10 ** (gain / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + k / q + k * k;
  const highPass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
  return [shelf, highPass];
}

export interface LoudnessOptions {
  /** Multiply the samples by this first. */
  gain?: number;
  /** Then clip them to ±ceiling (a rough stand-in for the player's limiter). */
  ceiling?: number;
  /** Only look at the first seconds. */
  maxSeconds?: number;
}

/** Integrated loudness (LUFS) of the channels (left and right count fully); -Infinity for silence. */
export function integratedLoudness(channels: Float32Array[], rate: number, options: LoudnessOptions = {}): number {
  const gain = options.gain ?? 1;
  const ceiling = options.ceiling ?? Number.POSITIVE_INFINITY;
  const hop = Math.round(rate / 10);
  const length = Math.min(channels[0]?.length ?? 0, options.maxSeconds ? Math.round(options.maxSeconds * rate) : Number.POSITIVE_INFINITY);
  const hops = Math.floor(length / hop);
  if (hops < 4) return Number.NEGATIVE_INFINITY;
  const energy = new Float64Array(hops);
  const [s, p] = kWeighting(rate);
  for (const data of channels) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let z1 = 0;
    let z2 = 0;
    for (let i = 0, end = hops * hop; i < end; i++) {
      let x = data[i] * gain;
      if (x > ceiling) x = ceiling;
      else if (x < -ceiling) x = -ceiling;
      const y = s.b0 * x + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      x2 = x1;
      x1 = x;
      // The high-pass's numerator is (1, -2, 1).
      const z = y - 2 * y1 + y2 - p.a1 * z1 - p.a2 * z2;
      y2 = y1;
      y1 = y;
      z2 = z1;
      z1 = z;
      energy[(i / hop) | 0] += z * z;
    }
  }
  // Mean square of each 400 ms block (four hops), summed over the channels.
  const blocks: number[] = [];
  for (let j = 0; j + 4 <= hops; j++) blocks.push((energy[j] + energy[j + 1] + energy[j + 2] + energy[j + 3]) / (4 * hop));
  const loudness = (ms: number) => -0.691 + 10 * Math.log10(ms);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const audible = blocks.filter((ms) => loudness(ms) > -70);
  if (audible.length === 0) return Number.NEGATIVE_INFINITY;
  const relativeGate = loudness(mean(audible)) - 10;
  const kept = audible.filter((ms) => loudness(ms) > relativeGate);
  return loudness(mean(kept));
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function clampGain(db: number): number {
  return Math.min(MAX_CUSTOM_GAIN_DB, Math.max(MIN_CUSTOM_GAIN_DB, db));
}

/**
 * The gain (dB) that brings audio to TARGET_LOUDNESS when a limiter at `ceiling` holds its peaks
 * down: the limiter takes some loudness off spiky sounds (crackles), so the gain is corrected for
 * that, as scripts/fetch-sounds.mjs does for the built-in loops. 0 for silence.
 */
export function matchingGain(channels: Float32Array[], rate: number, ceiling: number, maxSeconds?: number): { gainDb: number; loudness: number } {
  const loudness = integratedLoudness(channels, rate, { maxSeconds });
  if (!Number.isFinite(loudness)) return { gainDb: 0, loudness };
  let gainDb = clampGain(TARGET_LOUDNESS - loudness);
  for (let i = 0; i < 2; i++) {
    const reached = integratedLoudness(channels, rate, { gain: dbToGain(gainDb), ceiling, maxSeconds });
    if (!Number.isFinite(reached) || Math.abs(reached - TARGET_LOUDNESS) < 0.2) break;
    gainDb = clampGain(gainDb + TARGET_LOUDNESS - reached);
  }
  return { gainDb: Math.round(gainDb * 100) / 100, loudness };
}

/** The file's audio cannot be decoded here (VS Code's webviews have no Opus or AAC decoder). */
export class UndecodableError extends Error {}

/** Seconds of a file that are measured: plenty for ambient sound, and the decoded audio stays small. */
const MEASURE_SECONDS = 180;
const MEASURE_RATE = 32_000;
const MAX_WHOLE_FILE_BYTES = 48 * 1024 * 1024;

/** The file's duration from its metadata (NaN if the browser cannot tell). */
function durationOf(blob: Blob): Promise<number> {
  const url = URL.createObjectURL(blob);
  return new Promise<number>((resolve) => {
    const el = new Audio();
    const finish = (value: number) => {
      clearTimeout(timer);
      el.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(Number.NaN), 10_000);
    el.preload = 'metadata';
    el.addEventListener('loadedmetadata', () => finish(el.duration), { once: true });
    el.addEventListener('error', () => finish(Number.NaN), { once: true });
    el.src = url;
  });
}

/**
 * How much gain a sound file needs to be as loud as the built-in sounds, given the player's
 * limiter `ceiling`. Decodes at most the first few minutes. Throws an UndecodableError when the
 * file's audio cannot be decoded here.
 */
export async function measureFile(blob: Blob, ceiling: number): Promise<{ gainDb: number; loudness: number }> {
  const duration = await durationOf(blob);
  let bytes = blob.size;
  if (Number.isFinite(duration) && duration > MEASURE_SECONDS + 20) {
    // About the first minutes of the file (the bit rate is close enough to constant).
    bytes = Math.min(blob.size, Math.ceil((blob.size * (MEASURE_SECONDS + 20)) / duration) + 65_536);
  } else if (!Number.isFinite(duration)) {
    bytes = Math.min(blob.size, 24 * 1024 * 1024);
  }
  const ctx = new OfflineAudioContext(1, 1, MEASURE_RATE);
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(await blob.slice(0, bytes).arrayBuffer());
  } catch (err) {
    // Some formats cannot be decoded from their first part only (an index at the end): try it whole.
    if (bytes < blob.size && blob.size <= MAX_WHOLE_FILE_BYTES) {
      try {
        buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      } catch (whole) {
        throw new UndecodableError(whole instanceof Error ? whole.message : String(whole));
      }
    } else {
      throw new UndecodableError(err instanceof Error ? err.message : String(err));
    }
  }
  const left = buffer.getChannelData(0);
  // Mono plays on both speakers, so it is as loud as the same signal on two channels.
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  return matchingGain([left, right], buffer.sampleRate, ceiling, MEASURE_SECONDS);
}
