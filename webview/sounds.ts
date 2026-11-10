// Reading sounds: the floating panel behind the toolbar's headphones button (pick a sound,
// play/pause, volume) and the player behind it.
//
// The player streams a loop file through two <audio> elements ("decks") that take turns: a few
// seconds before the active deck reaches the end of the file, the other one starts from the
// beginning and the two crossfade, so the sound never stops and never clicks. Fades and volume
// run in Web Audio on the audio clock, so they stay smooth while the viewer tab is in the
// background. Only the viewer the extension names as the owner plays; the others just show the
// state, so two open documents never play two rains at once.
//
// VS Code's webviews may only start sound while handling a click or key press in them
// ("user-gesture-required"), and that is checked for each <audio> element separately. What is
// allowed once stays allowed, though: an element that played, or was load()ed during a click, and
// an AudioContext created during a click. So at the reader's first click or key press anywhere in
// the viewer, the player creates its audio output and all its decks and unlocks them; from then on
// the decks can take turns at the loop point, and the extension can hand the sound to this viewer,
// without another click. A viewer asked to play before it has had one waits for it.
import { soundLabel, volumeToGain, type SoundId, type SoundRequest, type SoundState } from '../src/shared/sounds';
import { h, icon, placeFloating } from './dom';

export interface SoundSource {
  id: SoundId;
  label: string;
  url: string;
}

/** The loops are Ogg Vorbis (VS Code's webviews cannot play Opus or AAC). */
export function canPlaySounds(): boolean {
  try {
    return new Audio().canPlayType('audio/ogg; codecs="vorbis"') !== '' && typeof AudioContext === 'function';
  } catch {
    return false;
  }
}

// ---------- Icons (drawn here; codicons has no headphones or rain) ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
type SvgPart = [tag: string, attrs: Record<string, string>];

function svg(viewBox: string, size: number, parts: SvgPart[], className?: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  if (className) el.setAttribute('class', className);
  for (const [tag, attrs] of parts) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
    el.append(child);
  }
  return el;
}

const LINE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

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

const SOUND_ICONS: Record<SoundId, () => SVGSVGElement> = {
  rain: () =>
    svg('0 0 24 24', 28, [
      ['path', { ...LINE, d: 'M7.2 15.2h10a3.6 3.6 0 0 0 .5-7.15A5.6 5.6 0 0 0 6.9 7.5a3.85 3.85 0 0 0 .3 7.7Z' }],
      ['path', { ...LINE, d: 'M8.6 18.2l-.9 2.3M12.4 18.2l-.9 2.3M16.2 18.2l-.9 2.3' }],
    ]),
  fireplace: () =>
    svg('0 0 24 24', 28, [
      ['path', { ...LINE, d: 'M12 2.8c.5 2.4 2 3.7 3.3 5.3 1.2 1.5 1.9 2.9 1.9 4.6a5.2 5.2 0 0 1-10.4 0c0-1.8.8-3.2 1.9-4.4.2 1.2.7 2.1 1.6 2.5-.2-3.2.7-5.6 1.7-8Z' }],
      ['path', { ...LINE, d: 'M5 21.2l14-2.6M5 18.6l14 2.6' }],
    ]),
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

/** One sound: two decks taking turns over the same loop file, behind a fader. */
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

  /** Lets go of the file (after an error), so the next play loads it again. */
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
    if (this.holding) {
      // Looping on its own since a swap failed: try again once it has wrapped around.
      if (remaining > LOOP_LEAD_S) this.holding = false;
      return;
    }
    if (remaining > LOOP_LEAD_S) return;
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

export interface PlayerHooks {
  /** The sound broke (missing or damaged file…); it stopped. */
  error(id: SoundId, err: unknown): void;
  warn(id: SoundId, message: string): void;
  /** Paused from outside the viewer (media keys, the system's media controls). */
  interrupted(id: SoundId): void;
}

export class AmbientPlayer {
  private ctx?: AudioContext;
  private master?: GainNode;
  private readonly tracks = new Map<SoundId, Track>();
  private readonly blobs = new Map<SoundId, Promise<string>>();
  private current?: SoundId;
  private volume = 0;
  private unlocked = false;
  /** A suspend() of the output may still be pending; play() must resume it. */
  private suspending = false;

  constructor(
    private readonly sources: readonly SoundSource[],
    private readonly hooks: PlayerHooks,
  ) {}

  /** The sound that should be audible (undefined while paused). */
  get playing(): SoundId | undefined {
    return this.current;
  }

  /** Sound may start without a click: the reader has clicked or typed in this viewer. */
  get ready(): boolean {
    return this.unlocked;
  }

  /**
   * Call while handling a click or key press. Creates the audio output and every deck, and unlocks
   * them, so sound can start and go on later without another click. Returns false when the event
   * did not count as one (Esc, for example).
   */
  unlock(): boolean {
    if (!hasUserActivation()) return false;
    const ctx = this.context();
    // Resuming during a click also unlocks the output for later; a quiet output stays asleep.
    if (ctx.state !== 'running' && (this.current || !this.unlocked)) void ctx.resume().catch(() => undefined);
    for (const track of this.tracks.values()) track.unlock();
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
  async play(id: SoundId): Promise<void> {
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
    const track = this.tracks.get(id);
    if (!track) throw new Error(`${soundLabel(id)} is not part of this build`);
    track.setSource(await this.blobUrl(id));
    if (this.current !== id) return; // something else was chosen meanwhile
    if (previous && previous !== id) this.tracks.get(previous)?.fadeOut(SWITCH_S);
    try {
      await track.fadeIn(previous && previous !== id ? SWITCH_S : FADE_IN_S);
    } catch (err) {
      if (isBlocked(err)) this.unlocked = false;
      else if (!isAbort(err)) this.forget(id);
      throw err;
    }
  }

  pause(): void {
    const id = this.current;
    this.current = undefined;
    if (id) this.tracks.get(id)?.fadeOut(FADE_OUT_S);
  }

  /** Diagnostics for tests. */
  describe(): Record<string, unknown> {
    return {
      context: this.ctx?.state ?? 'none',
      ready: this.unlocked,
      current: this.current,
      master: this.master?.gain.value,
      tracks: Object.fromEntries([...this.tracks].map(([id, t]) => [id, { running: t.isRunning, ...t.describe() }])),
    };
  }

  /** The audio output, with a track (two decks) per sound; made at the first click. */
  private context(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'playback' });
      const master = ctx.createGain();
      master.gain.value = volumeToGain(this.volume);
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      for (const source of this.sources) {
        const id = source.id;
        this.tracks.set(
          id,
          new Track(ctx, master, {
            fatal: (err) => {
              this.forget(id);
              this.hooks.error(id, err);
            },
            warn: (message) => this.hooks.warn(id, message),
            interrupted: () => this.hooks.interrupted(id),
            stopped: () => this.idle(),
          }),
        );
      }
      // The output stopped on its own while a sound should play (the system took the device…).
      ctx.addEventListener('statechange', () => {
        if (this.current && !this.suspending && ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => undefined);
      });
    }
    return this.ctx;
  }

  /** Nothing plays: let the audio output sleep (it wakes up without a click, once unlocked). */
  private idle(): void {
    const ctx = this.ctx;
    if (!ctx || this.current || ctx.state !== 'running') return;
    if ([...this.tracks.values()].some((t) => t.isRunning)) return;
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

  /** Forgets a sound that failed, so playing it again loads the file from scratch. */
  private forget(id: SoundId): void {
    this.tracks.get(id)?.clearSource();
    const blob = this.blobs.get(id);
    this.blobs.delete(id);
    blob?.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
  }

  /** The file as a blob: URL (a local copy the decks can seek in freely). */
  private blobUrl(id: SoundId): Promise<string> {
    let pending = this.blobs.get(id);
    if (!pending) {
      const source = this.sources.find((s) => s.id === id);
      if (!source) return Promise.reject(new Error(`${soundLabel(id)} is not part of this build`));
      pending = fetch(source.url).then(async (response) => {
        if (!response.ok) throw new Error(`loading ${source.url} failed (HTTP ${response.status})`);
        return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'audio/ogg' }));
      });
      this.blobs.set(id, pending);
      pending.catch(() => this.blobs.delete(id));
    }
    return pending;
  }
}

// ---------- Floating panel ----------

interface PanelActions {
  choose(id: SoundId): void;
  togglePlay(): void;
  setVolume(volume: number, final: boolean): void;
  openChanged(open: boolean): void;
}

/** The floating "Reading sounds" panel. It closes as soon as it loses focus. */
class SoundsPanel {
  readonly element: HTMLElement;
  private readonly tiles = new Map<SoundId, HTMLButtonElement>();
  private readonly playButton = h('button', { class: 'mpv-sound-play', type: 'button' });
  private readonly volumeIcon = h('span', { class: 'mpv-sounds-volume-icon' });
  private readonly slider = h('input', { class: 'mpv-sounds-slider', type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Volume' });
  private readonly percent = h('span', { class: 'mpv-sounds-percent' });
  private anchor?: HTMLElement;
  private state?: SoundState;

  constructor(
    private readonly sources: readonly SoundSource[],
    private readonly actions: PanelActions,
  ) {
    const tiles = h('div', { class: 'mpv-sound-tiles', role: 'radiogroup', 'aria-label': 'Sound' });
    for (const source of sources) {
      const tile = h(
        'button',
        { class: 'mpv-sound-tile', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-sound': source.id, tabindex: '-1' },
        SOUND_ICONS[source.id](),
        h('span', { class: 'mpv-sound-name', text: source.label }),
        equalizer(),
      );
      tile.addEventListener('click', () => actions.choose(source.id));
      tile.addEventListener('keydown', (e) => this.onTileKey(e, source.id));
      this.tiles.set(source.id, tile);
      tiles.append(tile);
    }
    this.playButton.addEventListener('click', () => actions.togglePlay());
    this.slider.addEventListener('input', () => actions.setVolume(Number(this.slider.value) / 100, false));
    this.slider.addEventListener('change', () => actions.setVolume(Number(this.slider.value) / 100, true));

    this.element = h(
      'div',
      { class: 'mpv-popover mpv-sounds', role: 'dialog', 'aria-label': 'Reading sounds', tabindex: '-1', hidden: true },
      h('div', { class: 'mpv-sounds-header' }, h('span', { class: 'mpv-sounds-title', text: 'Reading sounds' })),
      tiles,
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

  show(anchor: HTMLElement): void {
    this.anchor = anchor;
    const r = anchor.getBoundingClientRect();
    placeFloating(this.element, r.left + r.width / 2, r.bottom - 6);
    this.actions.openChanged(true);
    // Focus the chosen sound: arrow keys switch sounds, Tab reaches play and the volume.
    const chosen = this.state ? this.tiles.get(this.state.sound) : undefined;
    (chosen ?? this.tiles.values().next().value ?? this.playButton).focus();
  }

  hide(restoreFocus = false): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.actions.openChanged(false);
    if (restoreFocus) this.anchor?.focus();
  }

  toggle(anchor: HTMLElement): void {
    if (this.open) this.hide();
    else this.show(anchor);
  }

  update(state: SoundState): void {
    this.state = state;
    let anyChecked = false;
    for (const [id, tile] of this.tiles) {
      const checked = id === state.sound;
      anyChecked ||= checked;
      tile.setAttribute('aria-checked', String(checked));
      tile.tabIndex = checked ? 0 : -1;
      tile.classList.toggle('mpv-sound-playing', checked && state.playing);
      tile.title = checked && state.playing ? `${soundLabel(id)} is playing` : `Play ${soundLabel(id).toLowerCase()} sounds`;
    }
    if (!anyChecked) {
      const first = this.tiles.values().next().value;
      if (first) first.tabIndex = 0;
    }
    const label = soundLabel(state.sound).toLowerCase();
    this.playButton.replaceChildren(icon(state.playing ? 'debug-pause' : 'play'));
    this.playButton.title = state.playing ? 'Pause' : `Play ${label} sounds`;
    this.playButton.setAttribute('aria-label', this.playButton.title);
    const percent = Math.round(state.volume * 100);
    this.slider.value = String(percent);
    this.slider.style.setProperty('--mpv-fill', `${percent}%`);
    this.slider.setAttribute('aria-valuetext', `${percent}%`);
    this.percent.textContent = `${percent}%`;
    this.volumeIcon.replaceChildren(icon(percent === 0 ? 'mute' : 'unmute'));
  }

  private onTileKey(e: KeyboardEvent, id: SoundId): void {
    const ids = this.sources.map((s) => s.id);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = ids[(ids.indexOf(id) + step + ids.length) % ids.length];
    this.tiles.get(next)?.focus();
    this.actions.choose(next);
  }
}

// ---------- Controller ----------

export interface ReadingSoundsHooks {
  /** Sends a request to the extension, which keeps the state shared by all viewers. */
  request(request: SoundRequest): void;
  /** The toolbar button shows whether a sound is playing. */
  stateChanged(state: SoundState): void;
  openChanged(open: boolean): void;
  /** Reports a problem (with a way to the log). */
  notify(message: string): void;
  /** A short tip for the reader. */
  hint(message: string): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export class ReadingSounds {
  private state: SoundState;
  private readonly player: AmbientPlayer;
  private readonly panel: SoundsPanel;
  /** A volume set here that the extension has not been told about yet. */
  private pendingVolume?: number;
  private volumeTimer?: ReturnType<typeof setTimeout>;
  /** This viewer should play but has had no click yet; it starts at the next one. */
  private waiting = false;
  private toldReady = false;

  constructor(
    sources: readonly SoundSource[],
    initial: SoundState,
    private readonly hooks: ReadingSoundsHooks,
  ) {
    this.state = initial;
    this.player = new AmbientPlayer(sources, {
      error: (id, err) => this.failed(id, err),
      warn: (id, message) => hooks.log('warn', `Reading sound "${id}": ${message}.`),
      interrupted: (id) => this.interrupted(id),
    });
    this.panel = new SoundsPanel(sources, {
      choose: (id) => this.choose(id),
      togglePlay: () => this.togglePlay(),
      setVolume: (volume, final) => this.changeVolume(volume, final),
      openChanged: (open) => hooks.openChanged(open),
    });
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

  /** Diagnostics for tests. */
  describe(): Record<string, unknown> {
    return { state: this.state, open: this.open, waiting: this.waiting, player: this.player.describe() };
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
    this.hooks.stateChanged(this.state);
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
  private wait(id: SoundId): void {
    if (this.waiting) return;
    this.waiting = true;
    this.hooks.log('info', `Reading sound "${id}" starts at the next click in this viewer (VS Code lets a viewer play sound only after one).`);
    this.hooks.hint(`Click anywhere in this viewer to start the ${soundLabel(id).toLowerCase()} sound.`);
  }

  private local(patch: Partial<SoundState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
    this.sync();
  }

  private choose(id: SoundId): void {
    this.player.unlock();
    if (this.state.playing && this.state.owner && this.state.sound === id) return;
    this.local({ sound: id, playing: true, owner: true });
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
  private interrupted(id: SoundId): void {
    if (!(this.state.playing && this.state.owner && this.state.sound === id)) return;
    this.hooks.log('info', `Reading sound "${id}" was paused from outside the viewer (media keys or the system's media controls).`);
    this.local({ playing: false, owner: false });
    this.hooks.request({ action: 'pause' });
  }

  private failed(id: SoundId, err: unknown): void {
    const message = messageOf(err);
    this.hooks.log('warn', `Reading sound "${id}" failed: ${message}`);
    this.player.pause();
    this.waiting = false;
    this.state = { ...this.state, playing: false, owner: false };
    this.render();
    this.hooks.request({ action: 'failed', message: `${id}: ${message}` });
    this.hooks.notify(`The ${soundLabel(id).toLowerCase()} sound could not be played: ${message}.`);
  }
}
