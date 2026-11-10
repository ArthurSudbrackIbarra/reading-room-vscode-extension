import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoundCoordinator, type SoundEntry, type SoundViewer } from '../../src/preview/SoundCoordinator';
import {
  BUILT_IN_SOUNDS,
  DEFAULT_CHOICES,
  DEFAULT_SOUND,
  DEFAULT_VOLUME,
  SOUND_CATEGORIES,
  categoryOf,
  clampGainDb,
  clampVolume,
  isCustomId,
  migrateSoundId,
  volumeToGain,
  type SoundState,
} from '../../src/shared/sounds';
import { fadeCurve } from '../../webview/sounds';
// @ts-expect-error -- plain ES module build script without type declarations
import { makeLoop } from '../../scripts/fetch-sounds.mjs';

const root = join(__dirname, '..', '..');
const FIRE = 'fire-home-fireplace';
const RAIN = 'rain-half-open-window';
const ROOF = 'rain-roof-window';
const MINE = 'custom-a1b2c3d4';

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

function setup(saved?: unknown, custom: string[] = []) {
  const viewers: FakeViewer[] = [];
  const writes: unknown[] = [];
  const playing: boolean[] = [];
  const catalog = {
    custom: [...custom],
    entries: (): SoundEntry[] => [...BUILT_IN_SOUNDS.map((s) => ({ id: s.id, category: s.category })), ...catalog.custom.map((id) => ({ id, category: 'custom' as const }))],
  };
  const coordinator = new SoundCoordinator<FakeViewer>(
    { get: () => saved, set: (value) => writes.push(value) },
    () => viewers,
    () => catalog.entries(),
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
  return { coordinator, viewers, writes, playing, add, remove, catalog };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sound helpers', () => {
  it('knows the categories of sound ids', () => {
    expect(categoryOf(RAIN)).toBe('rain');
    expect(categoryOf(FIRE)).toBe('fireplace');
    expect(categoryOf(MINE)).toBe('custom');
    expect(categoryOf('thunder')).toBeUndefined();
    expect(isCustomId(MINE)).toBe(true);
    expect(isCustomId('custom-../x')).toBe(false);
    expect(isCustomId('rain')).toBe(false);
  });

  it('turns the ids saved by 0.3 into their category defaults', () => {
    expect(migrateSoundId('rain')).toBe(RAIN);
    expect(migrateSoundId('fireplace')).toBe(FIRE);
    expect(migrateSoundId(ROOF)).toBe(ROOF);
    expect(migrateSoundId(3)).toBeUndefined();
  });

  it('validates volumes and gains', () => {
    expect(clampVolume(1.7)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume('0.5')).toBe(DEFAULT_VOLUME);
    expect(clampVolume(Number.NaN, 0.2)).toBe(0.2);
    expect(clampGainDb(3.5)).toBe(3.5);
    expect(clampGainDb(80)).toBe(24);
    expect(clampGainDb(-80)).toBe(-20);
    expect(clampGainDb('3')).toBeUndefined();
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

describe('built-in sounds', () => {
  it('have unique ids, and each category starts with its default', () => {
    expect(new Set(BUILT_IN_SOUNDS.map((s) => s.id)).size).toBe(BUILT_IN_SOUNDS.length);
    for (const category of SOUND_CATEGORIES.filter((c) => c !== 'custom')) {
      expect(BUILT_IN_SOUNDS.find((s) => s.category === category)?.id).toBe(DEFAULT_CHOICES[category]);
    }
    expect(DEFAULT_SOUND).toBe(RAIN);
    expect(DEFAULT_CHOICES.fireplace).toBe(FIRE);
  });

  it('each have their loop in media/sounds, a build entry, and a credit in the README', () => {
    const script = readFileSync(join(root, 'scripts', 'fetch-sounds.mjs'), 'utf8');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    for (const sound of BUILT_IN_SOUNDS) {
      expect(existsSync(join(root, 'media', 'sounds', sound.file)), sound.file).toBe(true);
      expect(script, sound.id).toContain(`id: '${sound.id}'`);
      expect(readme, sound.credit.url).toContain(sound.credit.url);
    }
  });
});

describe('SoundCoordinator', () => {
  it('starts paused with the saved sound, choices and volume, ignoring bad values', () => {
    const a = setup({ sound: ROOF, volume: 0.3, choices: { rain: ROOF, fireplace: 'fire-wet-log' } });
    const viewer = a.add('a');
    expect(a.coordinator.stateFor(viewer)).toEqual({
      sound: ROOF,
      choices: { rain: ROOF, fireplace: 'fire-wet-log', custom: undefined },
      volume: 0.3,
      playing: false,
      owner: false,
    });
    const b = setup({ sound: 'nope', volume: 'loud', choices: { rain: FIRE, fireplace: 7 } });
    expect(b.coordinator.stateFor(b.add('b'))).toEqual({ sound: DEFAULT_SOUND, choices: { ...DEFAULT_CHOICES }, volume: DEFAULT_VOLUME, playing: false, owner: false });
  });

  it('upgrades what 0.3 saved: its sound becomes the default of its category', () => {
    const { coordinator, add } = setup({ sound: 'fireplace', volume: 0.5 });
    expect(coordinator.stateFor(add('a'))).toMatchObject({ sound: FIRE, choices: { rain: RAIN, fireplace: FIRE }, volume: 0.5 });
  });

  it('plays in exactly one viewer and shows the state in all of them', () => {
    const { coordinator, add, playing } = setup();
    const a = add('a');
    const b = add('b');
    coordinator.handle(a, { action: 'play', sound: RAIN });
    expect(a.last).toMatchObject({ sound: RAIN, playing: true, owner: true });
    expect(b.last).toMatchObject({ sound: RAIN, playing: true, owner: false });
    // Choosing another sound in b moves the audio there.
    coordinator.handle(b, { action: 'play', sound: FIRE });
    expect(a.last).toMatchObject({ sound: FIRE, playing: true, owner: false });
    expect(b.last).toMatchObject({ sound: FIRE, playing: true, owner: true });
    // Pausing from any viewer pauses everywhere.
    coordinator.handle(a, { action: 'pause' });
    expect(a.last).toMatchObject({ playing: false, owner: false });
    expect(b.last).toMatchObject({ playing: false, owner: false });
    expect(playing).toEqual([true, false]);
  });

  it('makes the played recording its category choice, keeping the other categories', () => {
    const { coordinator, add } = setup();
    const a = add('a');
    coordinator.handle(a, { action: 'play', sound: ROOF });
    coordinator.handle(a, { action: 'play', sound: 'fire-log-cabin' });
    expect(a.last).toMatchObject({ sound: 'fire-log-cabin', choices: { rain: ROOF, fireplace: 'fire-log-cabin', custom: undefined } });
  });

  it('remembers the chosen sound at once and the volume after a pause in the slider', () => {
    vi.useFakeTimers();
    const { coordinator, add, writes } = setup();
    const a = add('a');
    const b = add('b');
    coordinator.handle(a, { action: 'play', sound: FIRE });
    const firstWrite = { sound: FIRE, volume: DEFAULT_VOLUME, choices: { ...DEFAULT_CHOICES } };
    expect(writes).toEqual([firstWrite]);
    const before = a.received.length;
    coordinator.handle(a, { action: 'volume', volume: 0.4 });
    coordinator.handle(a, { action: 'volume', volume: 0.45 });
    // The viewer that moved the slider is not told again; the others are.
    expect(a.received.length).toBe(before);
    expect(b.last).toMatchObject({ volume: 0.45 });
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(writes).toEqual([firstWrite, { ...firstWrite, volume: 0.45 }]);
  });

  it('writes a pending volume when disposed', () => {
    vi.useFakeTimers();
    const { coordinator, add, writes } = setup();
    coordinator.handle(add('a'), { action: 'volume', volume: 0.2 });
    coordinator.dispose();
    expect(writes).toEqual([{ sound: DEFAULT_SOUND, volume: 0.2, choices: { ...DEFAULT_CHOICES } }]);
  });

  it('stops when the playing viewer fails, but not when another one does', () => {
    const { coordinator, add, playing } = setup();
    const a = add('a');
    const b = add('b');
    coordinator.play(a);
    const count = a.received.length;
    coordinator.handle(b, { action: 'failed', sound: RAIN, message: 'x' });
    expect(coordinator.isPlaying).toBe(true);
    expect(a.received.length).toBe(count);
    expect(b.last).toMatchObject({ playing: true, owner: false });
    coordinator.handle(a, { action: 'failed', sound: RAIN, message: 'blocked' });
    expect(coordinator.isPlaying).toBe(false);
    expect(b.last).toMatchObject({ playing: false });
    expect(playing).toEqual([true, false]);
  });

  it('hands the sound to another viewer when the playing one closes', () => {
    const { coordinator, add, remove } = setup();
    const a = add('a');
    const b = add('b');
    coordinator.play(a, FIRE);
    remove(a);
    coordinator.viewerClosed(a, b);
    expect(b.last).toMatchObject({ sound: FIRE, playing: true, owner: true });
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
    coordinator.play(a, RAIN);
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

  it('ignores unknown sounds in requests, and puts the asking viewer right', () => {
    const { coordinator, add } = setup();
    const a = add('a');
    coordinator.handle(a, { action: 'play', sound: 'thunder' });
    expect(coordinator.isPlaying).toBe(false);
    expect(a.last).toMatchObject({ sound: DEFAULT_SOUND, playing: false });
  });

  it('keeps a saved custom choice until the custom sounds are loaded', () => {
    const { coordinator, add, catalog } = setup({ sound: MINE, choices: { custom: MINE } });
    const a = add('a');
    expect(coordinator.stateFor(a)).toMatchObject({ sound: MINE, choices: { custom: MINE } });
    catalog.custom = [MINE];
    coordinator.catalogChanged();
    expect(a.last).toMatchObject({ sound: MINE, choices: { custom: MINE } });
    // Loaded, and that sound is not among them (removed in another window): back to rain.
    const other = setup({ sound: MINE, choices: { custom: MINE } });
    const b = other.add('b');
    other.coordinator.catalogChanged();
    expect(b.last).toMatchObject({ sound: RAIN, choices: { custom: undefined } });
  });

  it('chooses a sound just added without playing it', () => {
    const { coordinator, add, catalog, writes } = setup();
    const a = add('a');
    catalog.custom = [MINE];
    coordinator.catalogChanged();
    coordinator.choose(MINE);
    expect(a.last).toMatchObject({ sound: RAIN, playing: false, choices: { custom: MINE } });
    expect(writes[writes.length - 1]).toMatchObject({ choices: { custom: MINE } });
    coordinator.choose('custom-unknown1');
    expect(a.last).toMatchObject({ choices: { custom: MINE } });
  });

  it('stops when the custom sound that plays is removed, and moves the choice on', () => {
    const { coordinator, add, catalog, playing } = setup(undefined, [MINE, 'custom-zzzz9999']);
    coordinator.catalogChanged();
    const a = add('a');
    coordinator.handle(a, { action: 'play', sound: MINE });
    expect(a.last).toMatchObject({ sound: MINE, playing: true, choices: { custom: MINE } });
    catalog.custom = ['custom-zzzz9999'];
    coordinator.catalogChanged();
    expect(a.last).toMatchObject({ sound: 'custom-zzzz9999', playing: false, owner: false, choices: { custom: 'custom-zzzz9999' } });
    expect(playing).toEqual([true, false]);
    // The last custom sound goes: the choice empties and the sound falls back to rain.
    catalog.custom = [];
    coordinator.catalogChanged();
    expect(a.last).toMatchObject({ sound: RAIN, choices: { rain: RAIN, custom: undefined } });
  });

  it('leaves the playing sound alone when another custom sound is removed', () => {
    const { coordinator, add, catalog } = setup(undefined, [MINE, 'custom-zzzz9999']);
    coordinator.catalogChanged();
    const a = add('a');
    coordinator.handle(a, { action: 'play', sound: ROOF });
    catalog.custom = [MINE];
    coordinator.catalogChanged();
    expect(a.last).toMatchObject({ sound: ROOF, playing: true, owner: true });
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
