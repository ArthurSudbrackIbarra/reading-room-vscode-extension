import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoundCoordinator, type SoundViewer } from '../../src/preview/SoundCoordinator';
import { DEFAULT_SOUND, DEFAULT_VOLUME, clampVolume, isSoundId, volumeToGain, type SoundState } from '../../src/shared/sounds';
import { fadeCurve } from '../../webview/sounds';
// @ts-expect-error -- plain ES module build script without type declarations
import { makeLoop } from '../../scripts/fetch-sounds.mjs';

class FakeViewer implements SoundViewer {
  readonly received: SoundState[] = [];
  isDisposed = false;
  constructor(readonly name: string) {}
  postSound(state: SoundState): void {
    this.received.push(state);
  }
  get last(): SoundState | undefined {
    return this.received[this.received.length - 1];
  }
}

function setup(saved?: unknown) {
  const viewers: FakeViewer[] = [];
  const writes: unknown[] = [];
  const playing: boolean[] = [];
  const coordinator = new SoundCoordinator<FakeViewer>(
    { get: () => saved, set: (value) => writes.push(value) },
    () => viewers,
    (p) => playing.push(p),
  );
  const add = (name: string) => {
    const viewer = new FakeViewer(name);
    viewers.push(viewer);
    return viewer;
  };
  const remove = (viewer: FakeViewer) => {
    viewer.isDisposed = true;
    viewers.splice(viewers.indexOf(viewer), 1);
  };
  return { coordinator, viewers, writes, playing, add, remove };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sound helpers', () => {
  it('validates ids and volumes', () => {
    expect(isSoundId('rain')).toBe(true);
    expect(isSoundId('fireplace')).toBe(true);
    expect(isSoundId('thunder')).toBe(false);
    expect(clampVolume(1.7)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume('0.5')).toBe(DEFAULT_VOLUME);
    expect(clampVolume(Number.NaN, 0.2)).toBe(0.2);
  });

  it('maps the slider to a squared gain', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBe(1);
    expect(volumeToGain(0.5)).toBeCloseTo(0.25);
    expect(volumeToGain(2)).toBe(1);
  });

  it('builds equal-power fade curves', () => {
    const up = fadeCurve(0, 1, 9);
    const down = fadeCurve(1, 0, 9);
    expect(up[0]).toBeCloseTo(0);
    expect(up[8]).toBeCloseTo(1);
    expect(down[0]).toBeCloseTo(1);
    expect(down[8]).toBeCloseTo(0);
    // Two crossfading uncorrelated sounds keep their summed power.
    for (let i = 0; i < 9; i++) expect(up[i] ** 2 + down[i] ** 2).toBeCloseTo(1, 5);
    // From a partial level.
    const partial = fadeCurve(0.4, 1, 5);
    expect(partial[0]).toBeCloseTo(0.4);
    expect(partial[4]).toBeCloseTo(1);
  });
});

describe('SoundCoordinator', () => {
  it('starts paused with the saved sound and volume, ignoring bad values', () => {
    const a = setup({ sound: 'fireplace', volume: 0.3 });
    const viewer = a.add('a');
    expect(a.coordinator.stateFor(viewer)).toEqual({ sound: 'fireplace', volume: 0.3, playing: false, owner: false });
    const b = setup({ sound: 'nope', volume: 'loud' });
    expect(b.coordinator.stateFor(b.add('b'))).toEqual({ sound: DEFAULT_SOUND, volume: DEFAULT_VOLUME, playing: false, owner: false });
  });

  it('plays in exactly one viewer and shows the state in all of them', () => {
    const { coordinator, add, playing } = setup();
    const a = add('a');
    const b = add('b');
    coordinator.handle(a, { action: 'play', sound: 'rain' });
    expect(a.last).toMatchObject({ sound: 'rain', playing: true, owner: true });
    expect(b.last).toMatchObject({ sound: 'rain', playing: true, owner: false });
    // Choosing another sound in b moves the audio there.
    coordinator.handle(b, { action: 'play', sound: 'fireplace' });
    expect(a.last).toMatchObject({ sound: 'fireplace', playing: true, owner: false });
    expect(b.last).toMatchObject({ sound: 'fireplace', playing: true, owner: true });
    // Pausing from any viewer pauses everywhere.
    coordinator.handle(a, { action: 'pause' });
    expect(a.last).toMatchObject({ playing: false, owner: false });
    expect(b.last).toMatchObject({ playing: false, owner: false });
    expect(playing).toEqual([true, false]);
  });

  it('remembers the chosen sound at once and the volume after a pause in the slider', () => {
    vi.useFakeTimers();
    const { coordinator, add, writes } = setup();
    const a = add('a');
    const b = add('b');
    coordinator.handle(a, { action: 'play', sound: 'fireplace' });
    expect(writes).toEqual([{ sound: 'fireplace', volume: DEFAULT_VOLUME }]);
    const before = a.received.length;
    coordinator.handle(a, { action: 'volume', volume: 0.4 });
    coordinator.handle(a, { action: 'volume', volume: 0.45 });
    // The viewer that moved the slider is not told again; the others are.
    expect(a.received.length).toBe(before);
    expect(b.last).toMatchObject({ volume: 0.45 });
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(writes).toEqual([
      { sound: 'fireplace', volume: DEFAULT_VOLUME },
      { sound: 'fireplace', volume: 0.45 },
    ]);
  });

  it('writes a pending volume when disposed', () => {
    vi.useFakeTimers();
    const { coordinator, add, writes } = setup();
    coordinator.handle(add('a'), { action: 'volume', volume: 0.2 });
    coordinator.dispose();
    expect(writes).toEqual([{ sound: DEFAULT_SOUND, volume: 0.2 }]);
  });

  it('stops when the playing viewer fails, but not when another one does', () => {
    const { coordinator, add, playing } = setup();
    const a = add('a');
    const b = add('b');
    coordinator.play(a);
    const count = a.received.length;
    coordinator.handle(b, { action: 'failed', message: 'x' });
    expect(coordinator.isPlaying).toBe(true);
    expect(a.received.length).toBe(count);
    expect(b.last).toMatchObject({ playing: true, owner: false });
    coordinator.handle(a, { action: 'failed', message: 'blocked' });
    expect(coordinator.isPlaying).toBe(false);
    expect(b.last).toMatchObject({ playing: false });
    expect(playing).toEqual([true, false]);
  });

  it('hands the sound to another viewer when the playing one closes', () => {
    const { coordinator, add, remove } = setup();
    const a = add('a');
    const b = add('b');
    coordinator.play(a, 'fireplace');
    remove(a);
    coordinator.viewerClosed(a, b);
    expect(b.last).toMatchObject({ sound: 'fireplace', playing: true, owner: true });
    expect(coordinator.currentOwner).toBe(b);
    remove(b);
    coordinator.viewerClosed(b, undefined);
    expect(coordinator.isPlaying).toBe(false);
    expect(coordinator.currentOwner).toBeUndefined();
  });

  it('ignores the closing of a viewer that was not playing', () => {
    const { coordinator, add, remove } = setup();
    const a = add('a');
    const b = add('b');
    coordinator.play(a);
    remove(b);
    coordinator.viewerClosed(b, a);
    expect(coordinator.isPlaying).toBe(true);
    expect(coordinator.currentOwner).toBe(a);
  });

  it('toggles for the command: pause, resume in the last viewer, or report no viewer', () => {
    const { coordinator, add } = setup();
    expect(coordinator.toggle()).toBe(false);
    const a = add('a');
    coordinator.play(a);
    expect(coordinator.toggle()).toBe(true);
    expect(coordinator.isPlaying).toBe(false);
    expect(coordinator.toggle()).toBe(true);
    expect(a.last).toMatchObject({ playing: true, owner: true });
  });

  it('hands the sound over to a viewer that has had a click, if there is one', () => {
    const { coordinator, add, remove } = setup();
    const a = add('a');
    const b = add('b');
    const c = add('c');
    coordinator.handle(c, { action: 'ready' });
    coordinator.play(a, 'rain');
    remove(a);
    // b is the active viewer, but only c can start sound without another click.
    coordinator.viewerClosed(a, b);
    expect(coordinator.currentOwner).toBe(c);
    expect(c.last).toMatchObject({ playing: true, owner: true });
    expect(b.last).toMatchObject({ playing: true, owner: false });
    // With no viewer ready, the preferred one takes it (it starts at the next click there).
    const d = setup();
    const x = d.add('x');
    const y = d.add('y');
    const z = d.add('z');
    d.coordinator.play(x);
    d.remove(x);
    d.coordinator.viewerClosed(x, z);
    expect(d.coordinator.currentOwner).toBe(z);
    expect(y.last).toMatchObject({ owner: false });
  });

  it('lets the command play in the active viewer when it can, else in one that can', () => {
    const { coordinator, add } = setup();
    const a = add('a');
    const b = add('b');
    coordinator.handle(a, { action: 'ready' });
    expect(coordinator.toggle(b)).toBe(true);
    expect(coordinator.currentOwner).toBe(a);
    coordinator.toggle(b);
    expect(coordinator.isPlaying).toBe(false);
    coordinator.handle(b, { action: 'ready' });
    coordinator.toggle(b);
    expect(coordinator.currentOwner).toBe(b);
    coordinator.toggle();
    // A reloaded page has had no click: it is not preferred until it gets one.
    coordinator.pageLoaded(b);
    coordinator.toggle(b);
    expect(coordinator.currentOwner).toBe(a);
  });

  it('ignores unknown sounds in requests', () => {
    const { coordinator, add } = setup();
    const a = add('a');
    coordinator.handle(a, { action: 'play', sound: 'thunder' as never });
    expect(a.last).toMatchObject({ sound: DEFAULT_SOUND, playing: true });
  });
});

describe('makeLoop (scripts/fetch-sounds.mjs)', () => {
  it('crossfades the end into the start, so the loop point is continuous', () => {
    // A 1 kHz-free test signal: a slow ramp per channel, so continuity is easy to see.
    const rate = 48_000;
    const loopSeconds = 0.5;
    const fadeSeconds = 0.1;
    const frames = Math.round((loopSeconds + fadeSeconds) * rate);
    const pcm = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      pcm[2 * i] = Math.sin(i / 300);
      pcm[2 * i + 1] = Math.cos(i / 500);
    }
    const loop: Float32Array = makeLoop(pcm, loopSeconds, fadeSeconds);
    const loopFrames = Math.round(loopSeconds * rate);
    expect(loop.length).toBe(loopFrames * 2);
    // Wrapping from the last frame to the first behaves like stepping one frame in the source.
    for (let c = 0; c < 2; c++) {
      const last = loop[(loopFrames - 1) * 2 + c];
      const first = loop[c];
      const ordinary = Math.abs(pcm[(loopFrames - 1) * 2 + c] - pcm[loopFrames * 2 + c]);
      expect(Math.abs(first - last)).toBeLessThan(ordinary + 1e-3);
    }
    // After the crossfade the loop is the source itself.
    const fadeFrames = Math.round(fadeSeconds * rate);
    expect(loop[fadeFrames * 2 + 10]).toBe(pcm[fadeFrames * 2 + 10]);
  });

  it('refuses audio shorter than the loop plus the crossfade', () => {
    expect(() => makeLoop(new Float32Array(100), 1, 1)).toThrow(/not enough audio/);
  });
});
