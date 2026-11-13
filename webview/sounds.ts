// Reading sounds: the floating panel behind the toolbar's headphones button (pick a category and a
// recording, add your own, play/pause, volume) and the player behind it.
//
// The player streams a loop file through two <audio> elements ("decks") that take turns: a few
// seconds before the active deck reaches the end of the file, the other one starts from the
// beginning and the two crossfade, so the sound never stops and never clicks. A pair of decks
// behind a fader is a "slot"; the player has a few and can play any sound in any of them, so
// switching sounds fades one slot out while another fades in. Fades and volume run in Web Audio on
// the audio clock, so they stay smooth while the viewer tab is in the background. Only the viewer
// the extension names as the owner plays; the others just show the state, so two open documents
// never play two rains at once.
//
// VS Code's webviews may only start sound while handling a click or key press in them
// ("user-gesture-required"), and that is checked for each <audio> element separately. What is
// allowed once stays allowed, though: an element that played, or was load()ed during a click, and
// an AudioContext created during a click. So at the reader's first click or key press anywhere in
// the viewer, the player creates its audio output and all its slots and unlocks every deck; from
// then on the decks can take turns at the loop point, any sound (even one added later) can start,
// and the extension can hand the sound to this viewer, without another click. A viewer asked to
// play before it has had one waits for it.
//
// The reader's own sounds are evened out to the loudness of the built-in loops: the gain is
// measured once (loudness.ts) and kept by the extension, and a limiter on the output holds down
// the peaks a large gain pushes up.
import { CATEGORY_LABELS, SOUND_CATEGORIES, categoryOf, volumeToGain, type SoundCategory, type SoundRequest, type SoundState } from '../src/shared/sounds';
import type { CustomSoundView } from '../src/shared/messages';
import { h, icon, placeUnder } from './dom';
import { svg } from './icons';
import { UndecodableError, dbToGain, measureFile } from './loudness';

export interface SoundSource {
  id: string;
  category: SoundCategory;
  name: string;
  url: string;
  /** Built-in sounds: what it sounds like, and the recording it comes from. */
  description?: string;
  credit?: { title: string; author: string; url: string };
  /** Custom sounds: the gain (dB) that matches the built-in loudness, once measured. */
  gainDb?: number;
}

export function customSource(sound: CustomSoundView): SoundSource {
  return { id: sound.id, category: 'custom', name: sound.name, url: sound.url, gainDb: sound.gainDb };
}

/** The built-in loops are Ogg Vorbis (VS Code's webviews cannot play Opus or AAC). */
export function canPlaySounds(): boolean {
  try {
    return new Audio().canPlayType('audio/ogg; codecs="vorbis"') !== '' && typeof AudioContext === 'function';
  } catch {
    return false;
  }
}

// ---------- Icons (drawn here; codicons has no headphones, rain or flame) ----------

// Drawn in a 24 px box and shown at 16 px: the stroke is heavier, so it matches the 1.3 px of the other icons.
const LINE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

export function headphonesIcon(): SVGSVGElement {
  return svg(
    '0 0 16 16',
    16,
    [
      ['path', { d: 'M2.6 10.2V8.4a5.4 5.4 0 0 1 10.8 0v1.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round' }],
      ['rect', { x: '1.6', y: '8.9', width: '3.4', height: '5.3', rx: '1.2', fill: 'currentColor' }],
      ['rect', { x: '11', y: '8.9', width: '3.4', height: '5.3', rx: '1.2', fill: 'currentColor' }],
    ],
    'mpv-svg-icon',
  );
}

const CATEGORY_ICONS: Record<SoundCategory, () => SVGSVGElement> = {
  rain: () =>
    svg(
      '0 0 24 24',
      16,
      [
        ['path', { ...LINE, d: 'M7.2 15.2h10a3.6 3.6 0 0 0 .5-7.15A5.6 5.6 0 0 0 6.9 7.5a3.85 3.85 0 0 0 .3 7.7Z' }],
        ['path', { ...LINE, d: 'M8.6 18.2l-.9 2.3M12.4 18.2l-.9 2.3M16.2 18.2l-.9 2.3' }],
      ],
      'mpv-svg-icon',
    ),
  fireplace: () =>
    svg(
      '0 0 24 24',
      16,
      [
        ['path', { ...LINE, d: 'M12 2.8c.5 2.4 2 3.7 3.3 5.3 1.2 1.5 1.9 2.9 1.9 4.6a5.2 5.2 0 0 1-10.4 0c0-1.8.8-3.2 1.9-4.4.2 1.2.7 2.1 1.6 2.5-.2-3.2.7-5.6 1.7-8Z' }],
        ['path', { ...LINE, d: 'M5 21.2l14-2.6M5 18.6l14 2.6' }],
      ],
      'mpv-svg-icon',
    ),
  custom: () =>
    svg(
      '0 0 24 24',
      16,
      [
        ['path', { ...LINE, d: 'M9 17.5V5.6l10-2.1v11.9' }],
        ['circle', { ...LINE, cx: '6.6', cy: '17.6', r: '2.4' }],
        ['circle', { ...LINE, cx: '16.6', cy: '15.5', r: '2.4' }],
      ],
      'mpv-svg-icon',
    ),
};

function equalizer(): HTMLElement {
  return h('span', { class: 'mpv-eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
}

// ---------- Player ----------

const FADE_IN_S = 1.2;
const FADE_OUT_S = 0.6;
const SWITCH_S = 1.0;
/** The next deck starts this long before the active one reaches the end of the file… */
const LOOP_LEAD_S = 6;
/** …and the two crossfade over (at most) this long. */
const LOOP_FADE_S = 4;
const RESUME_TIMEOUT_MS = 2000;
/** Slots (pairs of decks): one fading in, one fading out, and one spare for quick switching. */
const SLOT_COUNT = 3;
/**
 * The output limiter: it holds down the peaks of a custom sound whose level was raised (a quiet
 * fire recording's crackles), and leaves the built-in loops (peaks under -2 dBFS) alone.
 */
const LIMITER: DynamicsCompressorOptions = { threshold: -2, knee: 1, ratio: 20, attack: 0.001, release: 0.05 };
const LIMITER_CEILING = dbToGain(LIMITER.threshold ?? -2);

/** Equal-power fade between two gains (sine/cosine shaped): two crossfading sounds keep their loudness. */
export function fadeCurve(from: number, to: number, steps = 32): Float32Array {
  const curve = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const x = i / (steps - 1);
    const shape = to >= from ? Math.sin((x * Math.PI) / 2) : 1 - Math.cos((x * Math.PI) / 2);
    curve[i] = from + (to - from) * shape;
  }
  return curve;
}

/** Moves an AudioParam from its current value to `to` over `seconds`, on the audio clock. */
function fadeParam(param: AudioParam, ctx: BaseAudioContext, to: number, seconds: number): void {
  const t = ctx.currentTime;
  const from = param.value;
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(t);
  } else {
    param.cancelScheduledValues(t);
    param.setValueAtTime(from, t);
  }
  if (seconds <= 0 || Math.abs(to - from) < 1e-4) {
    param.setValueAtTime(to, t);
    return;
  }
  try {
    param.setValueCurveAtTime(fadeCurve(from, to), t + 0.005, seconds);
  } catch {
    param.linearRampToValueAtTime(to, t + seconds);
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** The browser refused to start sound: this viewer has not had a click yet. */
export function isBlocked(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotAllowedError';
}

function blocked(): DOMException {
  return new DOMException('sound can only start after a click in the viewer', 'NotAllowedError');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True while handling a click or key press (or when the browser cannot tell). */
function hasUserActivation(): boolean {
  const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
  return activation ? activation.isActive : true;
}

const AUDIO_TYPES: Record<string, string> = { ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac' };

/** The extension's gain at its makeup stage: a quiet signal through the limiter, measured offline. */
async function limiterMakeup(): Promise<number> {
  const rate = 8000;
  const ctx = new OfflineAudioContext(1, rate / 2, rate);
  const source = new ConstantSourceNode(ctx, { offset: 0.01 });
  source.connect(new DynamicsCompressorNode(ctx, LIMITER)).connect(ctx.destination);
  source.start();
  const out = (await ctx.startRendering()).getChannelData(0);
  const gain = out[out.length - 1] / 0.01;
  return Number.isFinite(gain) && gain >= 1 && gain < 4 ? gain : 1;
}

class Deck {
  readonly el = new Audio();
  readonly gain: GainNode;
  /** load()ed during a click, or played: it may start without one. */
  unlocked = false;
  /** This code paused it; the 'pause' event that follows is not a pause from outside. */
  private ownPause = false;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.el.preload = 'auto';
    this.gain = ctx.createGain();
    ctx.createMediaElementSource(this.el).connect(this.gain).connect(out);
  }

  pause(): void {
    if (this.el.paused) return;
    this.ownPause = true;
    this.el.pause();
  }

  /** For the 'pause' event: whether this code asked for it (and forget that it did). */
  takeOwnPause(): boolean {
    const own = this.ownPause;
    this.ownPause = false;
    return own;
  }
}

interface TrackHooks {
  /** The playing deck failed: this sound cannot go on. */
  fatal(err: unknown): void;
  warn(message: string): void;
  /** Something outside the viewer paused the playing deck (media keys, the system's media controls). */
  interrupted(): void;
  stopped(): void;
}

/** Two decks taking turns over the same loop file, behind a fader. */
class Track {
  readonly fader: GainNode;
  private readonly decks: [Deck, Deck];
  private url?: string;
  private active = 0;
  private running = false;
  private swapping = false;
  /** A swap failed, so the active deck loops on its own; the next swap is tried on its next pass. */
  private holding = false;
  private watch?: ReturnType<typeof setInterval>;
  private stopTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly ctx: AudioContext,
    out: AudioNode,
    private readonly hooks: TrackHooks,
  ) {
    this.fader = ctx.createGain();
    this.fader.gain.value = 0;
    this.fader.connect(out);
    this.decks = [new Deck(ctx, this.fader), new Deck(ctx, this.fader)];
    this.decks[1].gain.gain.value = 0;
    this.decks.forEach((deck, i) => {
      deck.el.addEventListener('timeupdate', () => {
        if (i === this.active) this.checkLoop();
      });
      deck.el.addEventListener('ended', () => this.ended(i));
      deck.el.addEventListener('pause', () => this.paused(i));
      deck.el.addEventListener('error', () => this.failed(i));
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Call during a click: lets both decks start later without one. */
  unlock(): void {
    for (const deck of this.decks) {
      if (deck.unlocked) continue;
      // A deck that has moved has played, so it is allowed already; load() would rewind it.
      if (deck.el.paused && deck.el.currentTime === 0) deck.el.load();
      deck.unlocked = true;
    }
  }

  /** The file both decks play (a blob: URL); set before the first play. */
  setSource(url: string): void {
    if (this.url === url) return;
    this.url = url;
    for (const deck of this.decks) deck.el.src = url;
  }

  /** Lets go of the file, so the next play loads it again. */
  clearSource(): void {
    this.stop();
    this.url = undefined;
    for (const deck of this.decks) {
      deck.el.removeAttribute('src');
      deck.el.load();
    }
  }

  /** Starts or resumes playback and fades in. */
  async fadeIn(seconds: number): Promise<void> {
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    fadeParam(this.fader.gain, this.ctx, 1, seconds);
    if (this.running) return;
    this.running = true;
    this.holding = false;
    this.watch = setInterval(() => this.checkLoop(), 1000);
    // Resume on the active deck only; a crossfade cut short by a pause is not continued.
    const deck = this.decks[this.active];
    const other = this.decks[1 - this.active];
    other.pause();
    if (other.el.currentTime !== 0) other.el.currentTime = 0;
    for (const d of this.decks) d.el.loop = false;
    fadeParam(other.gain.gain, this.ctx, 0, 0);
    fadeParam(deck.gain.gain, this.ctx, 1, 0);
    this.swapping = false;
    try {
      await deck.el.play();
      deck.unlocked = true;
    } catch (err) {
      if (isBlocked(err)) deck.unlocked = false;
      if (!isAbort(err)) this.stop();
      throw err;
    }
  }

  /** Fades out, then pauses (keeping the position, so playing again continues from there). */
  fadeOut(seconds: number): void {
    fadeParam(this.fader.gain, this.ctx, 0, seconds);
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => this.stop(), seconds * 1000 + 150);
  }

  stop(): void {
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    clearInterval(this.watch);
    this.watch = undefined;
    const wasRunning = this.running;
    this.running = false;
    this.holding = false;
    for (const deck of this.decks) deck.pause();
    if (wasRunning) this.hooks.stopped();
  }

  /** Back to the start of the file (for a slot that takes a different sound). */
  rewind(): void {
    this.active = 0;
    fadeParam(this.decks[0].gain.gain, this.ctx, 1, 0);
    fadeParam(this.decks[1].gain.gain, this.ctx, 0, 0);
  }

  /** Diagnostics for tests: what each deck is doing. */
  describe(): Record<string, unknown> {
    return {
      active: this.active,
      holding: this.holding,
      fader: this.fader.gain.value,
      decks: this.decks.map((d) => ({
        time: d.el.currentTime,
        duration: d.el.duration,
        paused: d.el.paused,
        loop: d.el.loop,
        unlocked: d.unlocked,
        gain: d.gain.gain.value,
      })),
    };
  }

  private checkLoop(): void {
    if (!this.running || this.swapping) return;
    const el = this.decks[this.active].el;
    const remaining = el.duration - el.currentTime;
    if (!Number.isFinite(remaining)) return;
    // A short file: start the next pass and crossfade earlier (but not over half of it).
    const lead = Math.min(LOOP_LEAD_S, el.duration / 3);
    if (this.holding) {
      // Looping on its own since a swap failed: try again once it has wrapped around.
      if (remaining > lead) this.holding = false;
      return;
    }
    if (remaining > lead) return;
    this.swap(Math.max(0.3, Math.min(LOOP_FADE_S, remaining - 0.5)));
  }

  private swap(seconds: number): void {
    const from = this.decks[this.active];
    const next = 1 - this.active;
    const to = this.decks[next];
    this.active = next;
    this.swapping = true;
    to.el.loop = false;
    if (to.el.currentTime !== 0) to.el.currentTime = 0;
    fadeParam(to.gain.gain, this.ctx, 1, seconds);
    fadeParam(from.gain.gain, this.ctx, 0, seconds);
    to.el.play().then(
      () => {
        this.swapping = false;
        to.unlocked = true;
        // The outgoing deck plays out its last seconds (fading) and stops at the end.
        from.el.loop = false;
      },
      (err: unknown) => {
        this.swapping = false;
        if (this.running && !isAbort(err)) this.hold(next, err);
      },
    );
  }

  /**
   * The next deck could not start. Rather than stop, keep the one that was playing going, looping
   * on its own (with a split-second seam at its loop point), and try the swap again next pass.
   */
  private hold(failed: number, err: unknown): void {
    const bad = this.decks[failed];
    const keep = this.decks[1 - failed];
    this.active = 1 - failed;
    this.holding = true;
    if (isBlocked(err)) bad.unlocked = false;
    bad.pause();
    fadeParam(bad.gain.gain, this.ctx, 0, 0);
    fadeParam(keep.gain.gain, this.ctx, 1, 0.05);
    keep.el.loop = true;
    if (keep.el.paused) {
      // It already ran out (a stalled tab): start it over.
      keep.el.currentTime = 0;
      keep.el.play().catch((e: unknown) => {
        if (this.running && !isAbort(e)) this.hooks.fatal(e);
      });
    }
    this.hooks.warn(`the next pass could not start (${messageOf(err)}), so the current one loops on its own for now`);
  }

  private ended(i: number): void {
    const deck = this.decks[i];
    deck.el.currentTime = 0;
    // The active deck ran out before its crossfade started (a stalled tab): carry on at once.
    if (i === this.active && this.running && !this.swapping) this.swap(0.3);
  }

  private paused(i: number): void {
    const deck = this.decks[i];
    if (deck.takeOwnPause() || deck.el.ended || !this.running || this.swapping || i !== this.active) return;
    this.hooks.interrupted();
  }

  private failed(i: number): void {
    if (!this.running) return;
    const error = this.decks[i].el.error;
    const err = new Error(error?.message || `media error ${error?.code ?? ''}`.trim());
    if (i === this.active && !this.swapping) this.hooks.fatal(err);
    else this.hooks.warn(`a player failed (${err.message})`);
  }
}

/** A track with the level (gain) of the sound it plays. */
interface Slot {
  track: Track;
  level: GainNode;
  sound?: string;
}

export interface PlayerHooks {
  /** The sound broke (missing or damaged file…); it stopped. */
  error(id: string, err: unknown): void;
  warn(id: string, message: string): void;
  /** Paused from outside the viewer (media keys, the system's media controls). */
  interrupted(id: string): void;
  /** A custom sound's level was measured (the extension keeps it). */
  measured(id: string, gainDb: number): void;
}

export class AmbientPlayer {
  private ctx?: AudioContext;
  private master?: GainNode;
  private readonly slots: Slot[] = [];
  private sources = new Map<string, SoundSource>();
  /** Loaded files: a blob (to measure) and a blob: URL (the decks can seek in it freely). */
  private readonly files = new Map<string, Promise<{ blob: Blob; url: string }>>();
  /** Levels of custom sounds being measured or measured here. */
  private readonly levels = new Map<string, Promise<number>>();
  private current?: string;
  private volume = 0;
  private unlocked = false;
  /** A suspend() of the output may still be pending; play() must resume it. */
  private suspending = false;

  constructor(
    sources: readonly SoundSource[],
    private readonly hooks: PlayerHooks,
  ) {
    this.setSources(sources);
  }

  /** The sound that should be audible (undefined while paused). */
  get playing(): string | undefined {
    return this.current;
  }

  /** Sound may start without a click: the reader has clicked or typed in this viewer. */
  get ready(): boolean {
    return this.unlocked;
  }

  /** The sounds on offer changed: forget the ones that are gone, apply levels measured elsewhere. */
  setSources(sources: readonly SoundSource[]): void {
    const next = new Map(sources.map((s) => [s.id, s]));
    for (const [id, old] of this.sources) {
      const now = next.get(id);
      if (!now || now.url !== old.url) {
        this.forget(id);
      } else if (now.gainDb !== undefined && now.gainDb !== old.gainDb) {
        this.levels.set(id, Promise.resolve(now.gainDb));
        this.applyLevel(id, now.gainDb);
      }
    }
    this.sources = next;
  }

  /**
   * Call while handling a click or key press. Creates the audio output and every slot, and unlocks
   * their decks, so sound can start and go on later without another click. Returns false when the
   * event did not count as one (Esc, for example).
   */
  unlock(): boolean {
    if (!hasUserActivation()) return false;
    const ctx = this.context();
    // Resuming during a click also unlocks the output for later; a quiet output stays asleep.
    if (ctx.state !== 'running' && (this.current || !this.unlocked)) void ctx.resume().catch(() => undefined);
    for (const slot of this.slots) slot.track.unlock();
    if (!this.unlocked) {
      this.unlocked = true;
      this.idle();
    }
    return true;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(volumeToGain(volume), this.ctx.currentTime, 0.04);
  }

  /** Plays `id`. Rejects with a NotAllowedError (see isBlocked) while the viewer has had no click. */
  async play(id: string): Promise<void> {
    const previous = this.current;
    this.current = id;
    if (!this.unlocked) throw blocked();
    const ctx = this.context();
    const running = () => ctx.state === 'running';
    if (!running() || this.suspending) {
      this.suspending = false;
      await Promise.race([ctx.resume().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS))]);
      if (this.current !== id) return;
      if (!running()) {
        this.unlocked = false;
        throw blocked();
      }
    }
    const source = this.sources.get(id);
    if (!source) throw new Error('this sound is not available any more');
    const [file, gainDb] = await Promise.all([
      this.file(source),
      this.level(source).catch((err: unknown) => {
        this.hooks.warn(id, `its loudness could not be measured (${messageOf(err)}), so it plays as it is`);
        return 0;
      }),
    ]);
    if (this.current !== id) return; // something else was chosen meanwhile
    const slot = this.slotFor(id);
    if (slot.sound !== id) {
      // The slot played another sound (fading out, if still running): it starts over with this one.
      slot.track.stop();
      slot.track.rewind();
      slot.sound = id;
    }
    slot.track.setSource(file.url);
    slot.level.gain.cancelScheduledValues(ctx.currentTime);
    slot.level.gain.setValueAtTime(dbToGain(gainDb), ctx.currentTime);
    for (const other of this.slots) {
      if (other !== slot && other.track.isRunning) other.track.fadeOut(SWITCH_S);
    }
    this.prune();
    try {
      await slot.track.fadeIn(previous && previous !== id ? SWITCH_S : FADE_IN_S);
    } catch (err) {
      if (isBlocked(err)) this.unlocked = false;
      else if (!isAbort(err)) this.forget(id);
      throw err;
    }
  }

  pause(): void {
    const id = this.current;
    this.current = undefined;
    if (!id) return;
    for (const slot of this.slots) if (slot.sound === id) slot.track.fadeOut(FADE_OUT_S);
  }

  /**
   * The gain (dB) that makes a custom sound as loud as the built-in ones: measured once, then
   * remembered by the extension. Rejects with an UndecodableError if its audio cannot be decoded.
   */
  measure(id: string): Promise<number> {
    const source = this.sources.get(id);
    return source ? this.level(source, true) : Promise.reject(new Error('this sound is not available any more'));
  }

  /** Diagnostics for tests. */
  describe(): Record<string, unknown> {
    return {
      context: this.ctx?.state ?? 'none',
      ready: this.unlocked,
      current: this.current,
      master: this.master?.gain.value,
      slots: this.slots.map((s) => ({ sound: s.sound, level: s.level.gain.value, running: s.track.isRunning, ...s.track.describe() })),
      files: [...this.files.keys()],
    };
  }

  /** The audio output, with its slots; made at the first click. */
  private context(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'playback' });
      const master = ctx.createGain();
      master.gain.value = volumeToGain(this.volume);
      // The compressor adds a little gain of its own (its "makeup"); the last stage takes it back.
      const makeup = ctx.createGain();
      master.connect(new DynamicsCompressorNode(ctx, LIMITER)).connect(makeup).connect(ctx.destination);
      limiterMakeup().then(
        (gain) => (makeup.gain.value = 1 / gain),
        () => undefined,
      );
      this.ctx = ctx;
      this.master = master;
      for (let i = 0; i < SLOT_COUNT; i++) {
        const level = ctx.createGain();
        level.connect(master);
        const slot: Slot = { level, track: undefined as unknown as Track };
        slot.track = new Track(ctx, level, {
          fatal: (err) => {
            const id = slot.sound;
            if (!id) return;
            this.forget(id);
            this.hooks.error(id, err);
          },
          warn: (message) => {
            if (slot.sound) this.hooks.warn(slot.sound, message);
          },
          interrupted: () => {
            if (slot.sound) this.hooks.interrupted(slot.sound);
          },
          stopped: () => this.idle(),
        });
        this.slots.push(slot);
      }
      // The output stopped on its own while a sound should play (the system took the device…).
      ctx.addEventListener('statechange', () => {
        if (this.current && !this.suspending && ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => undefined);
      });
    }
    return this.ctx;
  }

  /** The slot to play `id` in: the one that has it already, else a free one, else the quietest. */
  private slotFor(id: string): Slot {
    return (
      this.slots.find((s) => s.sound === id) ?? this.slots.find((s) => !s.track.isRunning) ?? [...this.slots].sort((a, b) => a.track.fader.gain.value - b.track.fader.gain.value)[0]
    );
  }

  private applyLevel(id: string, gainDb: number): void {
    if (!this.ctx) return;
    for (const slot of this.slots) if (slot.sound === id) slot.level.gain.setTargetAtTime(dbToGain(gainDb), this.ctx.currentTime, 0.3);
  }

  /** Nothing plays: let the audio output sleep (it wakes up without a click, once unlocked). */
  private idle(): void {
    const ctx = this.ctx;
    if (!ctx || this.current || ctx.state !== 'running') return;
    if (this.slots.some((s) => s.track.isRunning)) return;
    this.suspending = true;
    ctx.suspend().then(
      () => {
        this.suspending = false;
      },
      () => {
        this.suspending = false;
      },
    );
  }

  /** Forgets a sound (gone, or failed), so playing it again loads the file from scratch. */
  private forget(id: string): void {
    for (const slot of this.slots) {
      if (slot.sound !== id) continue;
      slot.track.clearSource();
      slot.sound = undefined;
    }
    this.levels.delete(id);
    const file = this.files.get(id);
    this.files.delete(id);
    file?.then((f) => URL.revokeObjectURL(f.url)).catch(() => undefined);
  }

  /** Lets go of files no slot plays (the reader's own sounds can be large). */
  private prune(): void {
    const keep = new Set(this.slots.map((s) => s.sound));
    keep.add(this.current);
    for (const [id, file] of this.files) {
      if (keep.has(id)) continue;
      this.files.delete(id);
      file.then((f) => URL.revokeObjectURL(f.url)).catch(() => undefined);
    }
  }

  /** The level (dB) of a sound: 0 for the built-in loops; custom sounds are measured once. */
  private level(source: SoundSource, fresh = false): Promise<number> {
    if (source.category !== 'custom') return Promise.resolve(0);
    if (source.gainDb !== undefined && !fresh) return Promise.resolve(source.gainDb);
    let pending = this.levels.get(source.id);
    if (!pending) {
      pending = this.file(source)
        .then((file) => measureFile(file.blob, LIMITER_CEILING))
        .then((result) => {
          this.hooks.measured(source.id, result.gainDb);
          return result.gainDb;
        });
      const mine = pending;
      this.levels.set(source.id, mine);
      mine.catch(() => {
        if (this.levels.get(source.id) === mine) this.levels.delete(source.id);
      });
    }
    return pending;
  }

  private file(source: SoundSource): Promise<{ blob: Blob; url: string }> {
    let pending = this.files.get(source.id);
    if (!pending) {
      pending = fetch(source.url).then(async (response) => {
        if (!response.ok) throw new Error(`loading the file failed (HTTP ${response.status})`);
        let blob = await response.blob();
        const extension = /\.(\w+)(?:$|[?#])/.exec(source.url)?.[1]?.toLowerCase() ?? '';
        const type = AUDIO_TYPES[extension];
        if (type && blob.type !== type) blob = new Blob([blob], { type });
        return { blob, url: URL.createObjectURL(blob) };
      });
      const mine = pending;
      this.files.set(source.id, mine);
      mine.catch(() => {
        if (this.files.get(source.id) === mine) this.files.delete(source.id);
      });
    }
    return pending;
  }
}

// ---------- Floating panel ----------

interface PanelActions {
  /** A category's tile: play its chosen recording (or just show the list if it has none). */
  chooseCategory(category: SoundCategory): void;
  chooseSound(id: string): void;
  togglePlay(): void;
  setVolume(volume: number, final: boolean): void;
  addSounds(): void;
  renameSound(id: string, name: string): void;
  removeSound(id: string): void;
  openChanged(open: boolean): void;
}

function tooltip(source: SoundSource): string {
  if (!source.credit) return source.name;
  return `${source.description ?? source.name}\nRecording: "${source.credit.title}" by ${source.credit.author} on Freesound (public domain)`;
}

/** The floating "Reading sounds" panel. It closes as soon as it loses focus. */
class SoundsPanel {
  readonly element: HTMLElement;
  private readonly tiles = new Map<SoundCategory, HTMLButtonElement>();
  private readonly list = h('div', { class: 'mpv-sound-list', role: 'radiogroup' });
  private readonly empty = h('p', {
    class: 'mpv-sounds-empty',
    text: 'Your own audio files loop like the sounds above, just as loud. MP3, Ogg Vorbis, WAV or FLAC.',
  });
  private readonly addButton = h(
    'button',
    { class: 'mpv-sound-item mpv-sounds-add', type: 'button', title: 'Add audio files as reading sounds (copies are kept by Reading Room)' },
    icon('add'),
    h('span', { class: 'mpv-sound-item-name', text: 'Add sound files…' }),
  );
  private readonly playButton = h('button', { class: 'mpv-btn mpv-sound-play', type: 'button' });
  private readonly volumeIcon = h('span', { class: 'mpv-sounds-volume-icon' });
  private readonly slider = h('input', { class: 'mpv-sounds-slider', type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Volume' });
  private readonly percent = h('span', { class: 'mpv-sounds-percent' });
  private anchor?: HTMLElement;
  private state?: SoundState;
  private sources: SoundSource[] = [];
  /** The category whose recordings the list shows. */
  private shown: SoundCategory = 'rain';
  /** A custom sound being renamed, or asking to confirm its removal. */
  private editing?: { id: string; mode: 'rename' | 'remove' };
  /** Ids of the rows in the list, to rebuild it only when they change. */
  private rowIds = '';

  constructor(private readonly actions: PanelActions) {
    // The kind of sound: one of three, so it sits in a well (as wide as the panel).
    const tiles = h('div', { class: 'mpv-seg mpv-seg-wide', role: 'radiogroup', 'aria-label': 'Kind of sound' });
    for (const category of SOUND_CATEGORIES) {
      const tile = h(
        'button',
        { class: 'mpv-btn', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-category': category, tabindex: '-1' },
        CATEGORY_ICONS[category](),
        h('span', { class: 'mpv-label', text: CATEGORY_LABELS[category] }),
      );
      tile.addEventListener('click', () => this.chooseCategory(category));
      tile.addEventListener('keydown', (e) => this.onTileKey(e, category));
      this.tiles.set(category, tile);
      tiles.append(tile);
    }
    this.addButton.addEventListener('click', () => actions.addSounds());
    this.playButton.addEventListener('click', () => actions.togglePlay());
    this.slider.addEventListener('input', () => actions.setVolume(Number(this.slider.value) / 100, false));
    this.slider.addEventListener('change', () => actions.setVolume(Number(this.slider.value) / 100, true));

    this.element = h(
      'div',
      { class: 'mpv-popover mpv-sounds', role: 'dialog', 'aria-label': 'Reading sounds', tabindex: '-1', hidden: true },
      h('div', { class: 'mpv-popover-title', text: 'Reading sounds' }),
      tiles,
      this.empty,
      h('div', { class: 'mpv-sound-rows' }, this.list, this.addButton),
      h('div', { class: 'mpv-menu-sep' }),
      h('div', { class: 'mpv-sounds-controls' }, this.playButton, this.volumeIcon, this.slider, this.percent),
    );
    document.body.append(this.element);

    // Close when focus goes anywhere else: another control in the viewer, a click on the page,
    // or outside the viewer (VS Code's own UI). The toolbar button toggles it itself.
    this.element.addEventListener('focusout', (e) => {
      const next = e.relatedTarget as Node | null;
      if (next && !this.element.contains(next) && !this.anchor?.contains(next)) this.hide();
    });
    document.addEventListener(
      'pointerdown',
      (e) => {
        const target = e.target as Node;
        if (this.open && !this.element.contains(target) && !this.anchor?.contains(target)) this.hide();
      },
      true,
    );
    window.addEventListener('blur', () => this.hide());
    this.element.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.hide(true);
    });
  }

  get open(): boolean {
    return !this.element.hidden;
  }

  /** Opens below `anchor`, showing `category` (default: the playing sound's) and focusing `focusId` if given. */
  show(anchor: HTMLElement, category?: SoundCategory, focusId?: string): void {
    this.anchor = anchor;
    this.editing = undefined;
    this.shown = category ?? (this.state ? categoryOf(this.state.sound) : undefined) ?? 'rain';
    this.render();
    placeUnder(this.element, anchor, 'end');
    this.actions.openChanged(true);
    // Focus the chosen recording: arrow keys switch recordings, Tab reaches the rest.
    const id = focusId ?? this.chosenId();
    (this.rowButton(id) ?? this.tiles.get(this.shown) ?? this.playButton).focus();
  }

  hide(restoreFocus = false): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.editing = undefined;
    this.actions.openChanged(false);
    if (restoreFocus) this.anchor?.focus();
  }

  toggle(anchor: HTMLElement): void {
    if (this.open) this.hide();
    else this.show(anchor);
  }

  setSources(sources: SoundSource[]): void {
    this.sources = sources;
    if (this.editing && !sources.some((s) => s.id === this.editing?.id)) this.editing = undefined;
    this.render();
  }

  update(state: SoundState): void {
    this.state = state;
    this.render();
  }

  /** Shows a category's recordings (the tile was clicked). */
  showCategory(category: SoundCategory): void {
    this.shown = category;
    this.editing = undefined;
    this.render();
  }

  private chooseCategory(category: SoundCategory): void {
    this.showCategory(category);
    this.actions.chooseCategory(category);
  }

  /** The recording the shown category plays. */
  private chosenId(): string | undefined {
    const inShown = this.sources.filter((s) => s.category === this.shown);
    const choice = this.state?.choices[this.shown];
    return inShown.find((s) => s.id === choice)?.id ?? inShown[0]?.id;
  }

  private rowButton(id: string | undefined): HTMLButtonElement | undefined {
    if (!id) return undefined;
    return this.list.querySelector<HTMLButtonElement>(`.mpv-sound-item[data-sound="${CSS.escape(id)}"]`) ?? undefined;
  }

  private render(): void {
    const state = this.state;
    const playingCategory = state?.playing ? categoryOf(state.sound) : undefined;
    for (const [category, tile] of this.tiles) {
      const shown = category === this.shown;
      tile.setAttribute('aria-checked', String(shown));
      tile.classList.toggle('mpv-active', shown);
      tile.tabIndex = shown ? 0 : -1;
      const name = CATEGORY_LABELS[category].toLowerCase();
      tile.title = category === playingCategory ? `Playing: ${this.nameOf(state?.sound)}` : category === 'custom' ? 'Your own sounds' : `Play ${name} sounds`;
    }
    this.renderList();
    if (!state) return;
    this.playButton.replaceChildren(icon(state.playing ? 'debug-pause' : 'play'));
    this.playButton.title = state.playing ? 'Pause' : `Play "${this.nameOf(state.sound)}"`;
    this.playButton.setAttribute('aria-label', this.playButton.title);
    const percent = Math.round(state.volume * 100);
    this.slider.value = String(percent);
    this.slider.style.setProperty('--mpv-fill', `${percent}%`);
    this.slider.setAttribute('aria-valuetext', `${percent}%`);
    this.percent.textContent = `${percent}%`;
    this.volumeIcon.replaceChildren(icon(percent === 0 ? 'mute' : 'unmute'));
  }

  private nameOf(id: string | undefined): string {
    return this.sources.find((s) => s.id === id)?.name ?? 'sound';
  }

  private renderList(): void {
    const sources = this.sources.filter((s) => s.category === this.shown);
    const custom = this.shown === 'custom';
    this.list.setAttribute('aria-label', custom ? 'Your sounds' : `${CATEGORY_LABELS[this.shown]} recordings`);
    this.empty.hidden = !custom;
    this.addButton.hidden = !custom;
    // Rebuild only when the rows themselves change (a name changes in place), so a focused row
    // keeps its focus and a name being typed is not lost when the list updates.
    const ids = JSON.stringify([this.shown, sources.map((s) => s.id), this.editing]);
    if (ids !== this.rowIds) {
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.mpv-sound-row')?.dataset.sound;
      this.rowIds = ids;
      this.list.replaceChildren(...sources.map((s) => this.buildRow(s)));
      this.list.hidden = sources.length === 0;
      if (focused && !this.editing) this.rowButton(focused)?.focus();
    } else {
      for (const source of sources) if (this.editing?.id !== source.id) this.nameRow(source);
    }
    const chosen = this.chosenId();
    const playing = this.state?.playing ? this.state.sound : undefined;
    for (const item of this.list.querySelectorAll<HTMLButtonElement>('.mpv-sound-item')) {
      const id = item.dataset.sound;
      const checked = id === chosen;
      item.setAttribute('aria-checked', String(checked));
      item.tabIndex = checked ? 0 : -1;
      const row = item.closest('.mpv-sound-row');
      row?.classList.toggle('mpv-selected', checked);
      row?.classList.toggle('mpv-sound-playing', id === playing);
    }
  }

  private buildRow(source: SoundSource): HTMLElement {
    const row = h('div', { class: 'mpv-sound-row', 'data-sound': source.id });
    const editing = this.editing?.id === source.id ? this.editing.mode : undefined;
    if (editing === 'rename') return this.renameRow(row, source);
    if (editing === 'remove') return this.removeRow(row, source);
    const item = h(
      'button',
      { class: 'mpv-sound-item', type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', 'data-sound': source.id },
      h('span', { class: 'mpv-sound-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'mpv-sound-item-name' }),
      equalizer(),
    );
    item.addEventListener('click', () => this.actions.chooseSound(source.id));
    item.addEventListener('keydown', (e) => this.onItemKey(e, source.id));
    row.append(item);
    if (source.category === 'custom') {
      // Rename and remove: on the picked row at all times (nothing depends on hover).
      const rename = h('button', { class: 'mpv-btn mpv-btn-sm mpv-sound-action', type: 'button', 'data-action': 'rename' }, icon('edit'));
      const remove = h('button', { class: 'mpv-btn mpv-btn-sm mpv-btn-danger mpv-sound-action', type: 'button', 'data-action': 'remove' }, icon('trash'));
      rename.addEventListener('click', () => this.edit(source.id, 'rename'));
      remove.addEventListener('click', () => this.edit(source.id, 'remove'));
      row.append(h('span', { class: 'mpv-sound-actions' }, rename, remove));
    }
    this.nameRow(source, row);
    return row;
  }

  /** Puts the sound's name (which can change) into its row. */
  private nameRow(source: SoundSource, row = this.list.querySelector<HTMLElement>(`.mpv-sound-row[data-sound="${CSS.escape(source.id)}"]`)): void {
    if (!row) return;
    const item = row.querySelector<HTMLElement>('.mpv-sound-item');
    const name = row.querySelector('.mpv-sound-item-name');
    if (!item || !name) return;
    name.textContent = source.name;
    item.title = tooltip(source);
    for (const button of row.querySelectorAll<HTMLElement>('.mpv-sound-action')) {
      const label = `${button.dataset.action === 'rename' ? 'Rename' : 'Remove'} "${source.name}"`;
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  }

  private edit(id: string, mode: 'rename' | 'remove'): void {
    this.editing = { id, mode };
    this.renderList();
    const row = this.list.querySelector<HTMLElement>(`.mpv-sound-row[data-sound="${CSS.escape(id)}"]`);
    if (mode === 'rename') {
      const input = row?.querySelector('input');
      input?.focus();
      input?.select();
    } else {
      row?.querySelector<HTMLButtonElement>('.mpv-sound-cancel')?.focus();
    }
  }

  private endEdit(id: string): void {
    if (this.editing?.id !== id) return;
    this.editing = undefined;
    this.renderList();
    this.rowButton(id)?.focus();
  }

  private renameRow(row: HTMLElement, source: SoundSource): HTMLElement {
    row.classList.add('mpv-sound-editing');
    const input = h('input', { class: 'mpv-field mpv-sound-rename', type: 'text', value: source.name, maxlength: '80', 'aria-label': `New name for "${source.name}"` });
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (save && name && name !== source.name) this.actions.renameSound(source.id, name);
      this.endEdit(source.id);
    };
    input.addEventListener('keydown', (e) => {
      // Typing is for the field: keep the viewer's shortcuts and the panel's Esc out of it.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    row.append(input);
    return row;
  }

  private removeRow(row: HTMLElement, source: SoundSource): HTMLElement {
    row.classList.add('mpv-sound-editing');
    const remove = h(
      'button',
      { class: 'mpv-btn mpv-btn-sm mpv-btn-label mpv-sound-confirm', type: 'button', title: 'Removes it from your sounds. Your own file is not touched.' },
      h('span', { class: 'mpv-label', text: 'Remove' }),
    );
    const cancel = h('button', { class: 'mpv-btn mpv-btn-sm mpv-btn-label mpv-sound-cancel', type: 'button' }, h('span', { class: 'mpv-label', text: 'Cancel' }));
    remove.addEventListener('click', () => {
      this.editing = undefined;
      this.actions.removeSound(source.id);
    });
    cancel.addEventListener('click', () => this.endEdit(source.id));
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.endEdit(source.id);
    });
    row.append(h('span', { class: 'mpv-sound-question', text: `Remove "${source.name}"?` }), remove, cancel);
    return row;
  }

  private onTileKey(e: KeyboardEvent, category: SoundCategory): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      (this.rowButton(this.chosenId()) ?? (this.addButton.hidden ? undefined : this.addButton))?.focus();
      return;
    }
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const all = SOUND_CATEGORIES;
    const next = all[(all.indexOf(category) + step + all.length) % all.length];
    this.tiles.get(next)?.focus();
    this.chooseCategory(next);
  }

  private onItemKey(e: KeyboardEvent, id: string): void {
    const source = this.sources.find((s) => s.id === id);
    if (!source) return;
    if (source.category === 'custom' && (e.key === 'F2' || e.key === 'Delete')) {
      e.preventDefault();
      this.edit(source.id, e.key === 'F2' ? 'rename' : 'remove');
      return;
    }
    const ids = this.sources.filter((s) => s.category === this.shown).map((s) => s.id);
    const index = ids.indexOf(source.id);
    let next: number;
    if (e.key === 'ArrowDown') next = index + 1;
    else if (e.key === 'ArrowUp') next = index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    else return;
    e.preventDefault();
    if (next < 0) {
      this.tiles.get(this.shown)?.focus();
      return;
    }
    if (next >= ids.length) {
      if (!this.addButton.hidden) this.addButton.focus();
      return;
    }
    this.rowButton(ids[next])?.focus();
    this.actions.chooseSound(ids[next]);
  }
}

// ---------- Controller ----------

export interface ReadingSoundsHooks {
  /** Sends a request to the extension, which keeps the state shared by all viewers. */
  request(request: SoundRequest): void;
  /** The toolbar button shows whether a sound is playing (and which). */
  stateChanged(state: SoundState, name: string): void;
  openChanged(open: boolean): void;
  /** The toolbar button the panel hangs from. */
  anchor(): HTMLElement | undefined;
  /** Reports a problem (with a way to the log). */
  notify(message: string): void;
  /** A short tip for the reader. */
  hint(message: string): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export class ReadingSounds {
  private state: SoundState;
  private readonly builtIns: SoundSource[];
  private custom: SoundSource[] = [];
  private readonly player: AmbientPlayer;
  private readonly panel: SoundsPanel;
  /** A volume set here that the extension has not been told about yet. */
  private pendingVolume?: number;
  private volumeTimer?: ReturnType<typeof setTimeout>;
  /** This viewer should play but has had no click yet; it starts at the next one. */
  private waiting = false;
  private toldReady = false;

  constructor(
    builtIns: readonly SoundSource[],
    initial: SoundState,
    private readonly hooks: ReadingSoundsHooks,
  ) {
    this.builtIns = [...builtIns];
    this.state = initial;
    this.player = new AmbientPlayer(this.builtIns, {
      error: (id, err) => this.failed(id, err),
      warn: (id, message) => hooks.log('warn', `Reading sound "${this.nameOf(id)}": ${message}.`),
      interrupted: (id) => this.interrupted(id),
      measured: (id, gainDb) => {
        hooks.log('info', `Reading sound "${this.nameOf(id)}" is leveled to match the built-in sounds (${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB).`);
        hooks.request({ action: 'measured', sound: id, gainDb });
      },
    });
    this.panel = new SoundsPanel({
      chooseCategory: (category) => this.chooseCategory(category),
      chooseSound: (id) => this.choose(id),
      togglePlay: () => this.togglePlay(),
      setVolume: (volume, final) => this.changeVolume(volume, final),
      addSounds: () => hooks.request({ action: 'add' }),
      renameSound: (id, name) => this.renameSound(id, name),
      removeSound: (id) => this.removeSound(id),
      openChanged: (open) => {
        // Another VS Code window may have added or removed sounds: ask for the current list.
        if (open) hooks.request({ action: 'refresh' });
        hooks.openChanged(open);
      },
    });
    this.panel.setSources(this.sources);
    // The first click or key press anywhere in the viewer unlocks sound for good (see the top of
    // this file). Capture phase, so nothing in the viewer can stop the event before it gets here.
    const onGesture = (e: Event) => this.gesture(e);
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
    this.render();
  }

  get open(): boolean {
    return this.panel.open;
  }

  toggle(anchor: HTMLElement): void {
    this.panel.toggle(anchor);
  }

  hide(): void {
    this.panel.hide();
  }

  /** The shared state, from the extension (this viewer or another one changed it). */
  apply(state: SoundState): void {
    this.state = this.pendingVolume === undefined ? state : { ...state, volume: this.pendingVolume };
    this.render();
    this.sync();
  }

  /** The reader's own sounds, from the extension. */
  setCustomSounds(sounds: CustomSoundView[]): void {
    this.custom = sounds.map(customSource);
    this.player.setSources(this.sources);
    this.panel.setSources(this.sources);
    this.render();
  }

  /** Sounds this viewer asked to add are in: measure how loud they are, and show them. */
  soundsAdded(ids: string[], reveal: boolean): void {
    const anchor = this.hooks.anchor();
    if (reveal && anchor) this.panel.show(anchor, 'custom', ids[0]);
    for (const id of ids) {
      this.player.measure(id).catch((err: unknown) => {
        if (err instanceof UndecodableError) {
          this.hooks.request({ action: 'unplayable', sound: id, message: err.message || 'unknown audio format' });
        } else {
          this.hooks.log('warn', `Measuring the loudness of reading sound "${this.nameOf(id)}" failed: ${messageOf(err)}`);
        }
      });
    }
  }

  /** Diagnostics for tests. */
  describe(): Record<string, unknown> {
    return { state: this.state, open: this.open, waiting: this.waiting, sounds: this.sources.map((s) => s.id), player: this.player.describe() };
  }

  private get sources(): SoundSource[] {
    return [...this.builtIns, ...this.custom];
  }

  private nameOf(id: string): string {
    return this.sources.find((s) => s.id === id)?.name ?? id;
  }

  /** How a message names a sound: "the rain sound (Roof window)", or a custom sound's name. */
  private describeSound(id: string): string {
    const source = this.sources.find((s) => s.id === id);
    if (!source) return 'the reading sound';
    return source.category === 'custom' ? `"${source.name}"` : `the ${CATEGORY_LABELS[source.category].toLowerCase()} sound (${source.name})`;
  }

  private gesture(e: Event): void {
    if (!e.isTrusted || !this.player.unlock()) return;
    if (!this.toldReady) {
      this.toldReady = true;
      this.hooks.request({ action: 'ready' });
    }
    if (this.waiting) {
      this.waiting = false;
      this.sync();
    }
  }

  private render(): void {
    this.panel.update(this.state);
    this.hooks.stateChanged(this.state, this.nameOf(this.state.sound));
  }

  /** Makes the audio match the state: play only in the owner viewer. */
  private sync(): void {
    this.player.setVolume(this.state.volume);
    if (!(this.state.playing && this.state.owner)) {
      this.waiting = false;
      this.player.pause();
      return;
    }
    const id = this.state.sound;
    if (!this.sources.some((s) => s.id === id)) return; // its list has not arrived yet
    if (!this.player.ready) {
      this.wait(id);
      return;
    }
    this.player.play(id).catch((err: unknown) => {
      if (this.player.playing !== id || isAbort(err)) return;
      if (isBlocked(err)) this.wait(id);
      else this.failed(id, err);
    });
  }

  /** Asked to play before the reader clicked in this viewer: start at the first click. */
  private wait(id: string): void {
    if (this.waiting) return;
    this.waiting = true;
    this.hooks.log('info', `Reading sound "${this.nameOf(id)}" starts at the next click in this viewer (VS Code lets a viewer play sound only after one).`);
    this.hooks.hint(`Click anywhere in this viewer to start ${this.describeSound(id)}.`);
  }

  private local(patch: Partial<SoundState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
    this.sync();
  }

  private chooseCategory(category: SoundCategory): void {
    const inCategory = this.sources.filter((s) => s.category === category);
    const choice = this.state.choices[category];
    const id = inCategory.find((s) => s.id === choice)?.id ?? inCategory[0]?.id;
    // An empty "Custom" just shows its list (with the button to add sounds).
    if (id) this.choose(id);
  }

  private choose(id: string): void {
    this.player.unlock();
    const category = categoryOf(id);
    if (!category) return;
    if (this.state.playing && this.state.owner && this.state.sound === id) return;
    this.local({ sound: id, choices: { ...this.state.choices, [category]: id }, playing: true, owner: true });
    this.hooks.request({ action: 'play', sound: id });
  }

  private togglePlay(): void {
    if (this.state.playing) {
      this.local({ playing: false, owner: false });
      this.hooks.request({ action: 'pause' });
      return;
    }
    this.player.unlock();
    this.local({ playing: true, owner: true });
    this.hooks.request({ action: 'play', sound: this.state.sound });
  }

  private renameSound(id: string, name: string): void {
    // Show the new name right away; the extension confirms it with the new list.
    this.custom = this.custom.map((s) => (s.id === id ? { ...s, name } : s));
    this.panel.setSources(this.sources);
    this.render();
    this.hooks.request({ action: 'rename', sound: id, name });
  }

  private removeSound(id: string): void {
    this.custom = this.custom.filter((s) => s.id !== id);
    this.player.setSources(this.sources);
    this.panel.setSources(this.sources);
    this.render();
    this.hooks.request({ action: 'remove', sound: id });
  }

  private changeVolume(volume: number, final: boolean): void {
    this.state = { ...this.state, volume };
    this.player.setVolume(volume);
    this.panel.update(this.state);
    this.pendingVolume = volume;
    // While the slider moves, tell the extension at most every 150 ms; always the final value.
    if (final) this.flushVolume();
    else this.volumeTimer ??= setTimeout(() => this.flushVolume(), 150);
  }

  private flushVolume(): void {
    clearTimeout(this.volumeTimer);
    this.volumeTimer = undefined;
    if (this.pendingVolume === undefined) return;
    const volume = this.pendingVolume;
    this.pendingVolume = undefined;
    this.hooks.request({ action: 'volume', volume });
  }

  /** Paused from outside the viewer (media keys, the system's media controls): pause everywhere. */
  private interrupted(id: string): void {
    if (!(this.state.playing && this.state.owner && this.state.sound === id)) return;
    this.hooks.log('info', `Reading sound "${this.nameOf(id)}" was paused from outside the viewer (media keys or the system's media controls).`);
    this.local({ playing: false, owner: false });
    this.hooks.request({ action: 'pause' });
  }

  private failed(id: string, err: unknown): void {
    const message = messageOf(err);
    this.hooks.log('warn', `Reading sound "${this.nameOf(id)}" failed: ${message}`);
    this.player.pause();
    this.waiting = false;
    this.state = { ...this.state, playing: false, owner: false };
    this.render();
    this.hooks.request({ action: 'failed', sound: id, message });
    const what = this.describeSound(id);
    this.hooks.notify(`${what.charAt(0).toUpperCase()}${what.slice(1)} could not be played: ${message}.`);
  }
}
