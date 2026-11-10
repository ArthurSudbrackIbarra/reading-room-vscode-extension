import { describe, expect, it } from 'vitest';
import { TARGET_LOUDNESS } from '../../src/shared/sounds';
import { dbToGain, integratedLoudness, kWeighting, matchingGain } from '../../webview/loudness';

function sine(rate: number, seconds: number, amplitude: number, frequency = 1000): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
  return out;
}

/** Deterministic noise with a few loud clicks, like a quiet fire with crackles. */
function crackles(rate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let i = 0; i < out.length; i++) out[i] = 0.01 * random();
  for (let i = 0; i < out.length; i += Math.round(rate * 0.3)) out[i] = 0.9;
  return out;
}

describe('loudness (BS.1770)', () => {
  it('uses the standard K-weighting at 48 kHz', () => {
    const [shelf, highPass] = kWeighting(48_000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 6);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 6);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 6);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 6);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 6);
    expect(highPass.a1).toBeCloseTo(-1.99004745483398, 6);
    expect(highPass.a2).toBeCloseTo(0.99007225036621, 6);
  });

  it('measures a stereo 1 kHz tone at -23 dBFS as -23 LUFS (EBU Tech 3341, case 1)', () => {
    for (const rate of [32_000, 44_100, 48_000]) {
      const tone = sine(rate, 10, dbToGain(-23));
      expect(integratedLoudness([tone, tone], rate)).toBeCloseTo(-23, 1);
    }
  });

  it('counts a tone on one channel 3 dB quieter', () => {
    const rate = 48_000;
    const tone = sine(rate, 5, dbToGain(-20));
    expect(integratedLoudness([tone, new Float32Array(tone.length)], rate)).toBeCloseTo(-23.01, 1);
  });

  it('gates out silence', () => {
    const rate = 48_000;
    const tone = sine(rate, 6, dbToGain(-20));
    const withGap = new Float32Array(tone.length * 2);
    withGap.set(tone.subarray(0, tone.length / 2), 0);
    withGap.set(tone.subarray(tone.length / 2), tone.length * 1.5);
    // Ungated, half silence would read 3 dB lower; only the blocks across the edges count a little.
    const gated = integratedLoudness([withGap, withGap], rate);
    expect(gated).toBeLessThan(-19.95);
    expect(gated).toBeGreaterThan(-20.5);
    expect(integratedLoudness([new Float32Array(rate * 2)], rate)).toBe(Number.NEGATIVE_INFINITY);
    expect(integratedLoudness([new Float32Array(100)], rate)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('can look at the first seconds only, with a gain', () => {
    const rate = 48_000;
    const loud = sine(rate, 4, dbToGain(-10));
    const both = new Float32Array(loud.length * 2);
    both.set(loud, 0);
    both.set(sine(rate, 4, dbToGain(-40)), loud.length);
    expect(integratedLoudness([both, both], rate, { maxSeconds: 4 })).toBeCloseTo(-10, 1);
    expect(integratedLoudness([loud, loud], rate, { gain: dbToGain(6) })).toBeCloseTo(-4, 1);
  });

  it('finds the gain that brings a sound to the target loudness', () => {
    const rate = 48_000;
    const tone = sine(rate, 5, dbToGain(-34));
    const { gainDb, loudness } = matchingGain([tone, tone], rate, dbToGain(-2));
    expect(loudness).toBeCloseTo(-34, 1);
    expect(gainDb).toBeCloseTo(TARGET_LOUDNESS + 34, 1);
  });

  it('adds gain for what the limiter takes off spiky sounds, within the limits', () => {
    const rate = 48_000;
    const fire = crackles(rate, 8);
    const plain = TARGET_LOUDNESS - integratedLoudness([fire, fire], rate);
    const { gainDb } = matchingGain([fire, fire], rate, dbToGain(-2));
    expect(gainDb).toBeGreaterThan(Math.min(plain, 24));
    expect(gainDb).toBeLessThanOrEqual(24);
    expect(matchingGain([new Float32Array(rate)], rate, 1)).toEqual({ gainDb: 0, loudness: Number.NEGATIVE_INFINITY });
  });
});
