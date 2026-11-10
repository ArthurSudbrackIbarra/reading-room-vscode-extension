// Reading sounds: the floating panel behind the toolbar's headphones button (pick a sound,
// play/pause, volume) and the player behind it.
//
// The player streams a loop file through two <audio> elements ("decks") that take turns: a few
// seconds before the active deck reaches the end of the file, the other one starts from the
// beginning and the two crossfade, so the sound never stops and never clicks. Fades and volume
// run in Web Audio on the audio clock, so they stay smooth while the viewer tab is in the
// background. Only the viewer the extension names as the owner plays; the others just show the
// state, so two open documents never play two rains at once.
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

class Deck {
  readonly el = new Audio();
  readonly gain: GainNode;

  constructor(ctx: AudioContext, url: string, out: AudioNode) {
    this.el.preload = 'auto';
    this.el.src = url;
    this.gain = ctx.createGain();
    ctx.createMediaElementSource(this.el).connect(this.gain).connect(out);
  }
}

/** One sound: two decks taking turns over the same loop file, behind a fader. */
class Track {
  readonly fader: GainNode;
  private readonly decks: [Deck, Deck];
  private active = 0;
  private running = false;
  private swapping = false;
  private watch?: ReturnType<typeof setInterval>;
  private stopTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly ctx: AudioContext,
    url: string,
    out: AudioNode,
    private readonly onError: (err: unknown) => void,
  ) {
    this.fader = ctx.createGain();
    this.fader.gain.value = 0;
    this.fader.connect(out);
    this.decks = [new Deck(ctx, url, this.fader), new Deck(ctx, url, this.fader)];
    this.decks[1].gain.gain.value = 0;
    this.decks.forEach((deck, i) => {
      deck.el.addEventListener('timeupdate', () => {
        if (i === this.active) this.checkLoop();
      });
      deck.el.addEventListener('ended', () => this.ended(i));
      deck.el.addEventListener('error', () => {
        if (this.running) this.onError(new Error(deck.el.error?.message || `media error ${deck.el.error?.code ?? ''}`.trim()));
      });
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Starts or resumes playback and fades in. */
  async fadeIn(seconds: number): Promise<void> {
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    fadeParam(this.fader.gain, this.ctx, 1, seconds);
    if (this.running) return;
    this.running = true;
    this.watch = setInterval(() => this.checkLoop(), 1000);
    // Resume on the active deck only; a crossfade cut short by a pause is not continued.
    const deck = this.decks[this.active];
    const other = this.decks[1 - this.active];
    other.el.pause();
    if (other.el.currentTime !== 0) other.el.currentTime = 0;
    fadeParam(other.gain.gain, this.ctx, 0, 0);
    fadeParam(deck.gain.gain, this.ctx, 1, 0);
    this.swapping = false;
    try {
      await deck.el.play();
    } catch (err) {
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
    this.running = false;
    for (const deck of this.decks) deck.el.pause();
  }

  /** Diagnostics for tests: what each deck is doing. */
  describe(): { active: number; decks: { time: number; duration: number; paused: boolean; gain: number }[]; fader: number } {
    return {
      active: this.active,
      fader: this.fader.gain.value,
      decks: this.decks.map((d) => ({ time: d.el.currentTime, duration: d.el.duration, paused: d.el.paused, gain: d.gain.gain.value })),
    };
  }

  private checkLoop(): void {
    if (!this.running || this.swapping) return;
    const el = this.decks[this.active].el;
    const remaining = el.duration - el.currentTime;
    if (!Number.isFinite(remaining) || remaining > LOOP_LEAD_S) return;
    this.swap(Math.max(0.3, Math.min(LOOP_FADE_S, remaining - 0.5)));
  }

  private swap(seconds: number): void {
    const from = this.decks[this.active];
    this.active = 1 - this.active;
    const to = this.decks[this.active];
    this.swapping = true;
    if (to.el.currentTime !== 0) to.el.currentTime = 0;
    fadeParam(to.gain.gain, this.ctx, 1, seconds);
    fadeParam(from.gain.gain, this.ctx, 0, seconds);
    to.el.play().then(
      () => {
        this.swapping = false;
      },
      (err: unknown) => {
        this.swapping = false;
        if (this.running && !isAbort(err)) this.onError(err);
      },
    );
  }

  private ended(i: number): void {
    const deck = this.decks[i];
    deck.el.currentTime = 0;
    // The active deck ran out before its crossfade started (a stalled tab): carry on at once.
    if (i === this.active && this.running && !this.swapping) this.swap(0.3);
  }
}

export class AmbientPlayer {
  private ctx?: AudioContext;
  private master?: GainNode;
  private readonly tracks = new Map<SoundId, Track>();
  private readonly blobs = new Map<SoundId, Promise<string>>();
  private current?: SoundId;
  private volume = 0;

  constructor(
    private readonly sources: readonly SoundSource[],
    private readonly onError: (id: SoundId, err: unknown) => void,
  ) {}

  /** The sound that should be audible (undefined while paused). */
  get playing(): SoundId | undefined {
    return this.current;
  }

  /** Creates or resumes the audio output. Call it from a click, so the browser allows sound. */
  unlock(): void {
    const ctx = this.context();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(volumeToGain(volume), this.ctx.currentTime, 0.04);
  }

  async play(id: SoundId): Promise<void> {
    const previous = this.current;
    this.current = id;
    const ctx = this.context();
    const running = () => ctx.state === 'running';
    if (!running()) {
      await Promise.race([ctx.resume(), new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS))]);
      if (!running()) throw new Error('audio output is blocked until you click play in the viewer');
    }
    const track = await this.track(id);
    if (this.current !== id) return; // something else was chosen meanwhile
    if (previous && previous !== id) this.tracks.get(previous)?.fadeOut(SWITCH_S);
    try {
      await track.fadeIn(previous && previous !== id ? SWITCH_S : FADE_IN_S);
    } catch (err) {
      if (!isAbort(err)) this.drop(id);
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
      current: this.current,
      master: this.master?.gain.value,
      tracks: Object.fromEntries([...this.tracks].map(([id, t]) => [id, { running: t.isRunning, ...t.describe() }])),
    };
  }

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.master = this.ctx.createGain();
      this.master.gain.value = volumeToGain(this.volume);
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private async track(id: SoundId): Promise<Track> {
    const existing = this.tracks.get(id);
    if (existing) return existing;
    const url = await this.blobUrl(id);
    const created = this.tracks.get(id); // made by a concurrent call meanwhile
    if (created) return created;
    const ctx = this.context();
    const track = new Track(ctx, url, this.master ?? ctx.destination, (err) => {
      this.drop(id);
      this.onError(id, err);
    });
    this.tracks.set(id, track);
    return track;
  }

  /** Forgets a track that failed, so playing it again starts from scratch. */
  private drop(id: SoundId): void {
    this.tracks.get(id)?.stop();
    this.tracks.delete(id);
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
  private readonly status = h('span', { class: 'mpv-sounds-status' });
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
      h('div', { class: 'mpv-sounds-header' }, h('span', { class: 'mpv-sounds-title', text: 'Reading sounds' }), this.status),
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
    this.status.textContent = state.playing ? 'Playing on a loop' : 'Paused';
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
  notify(message: string): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export class ReadingSounds {
  private state: SoundState;
  private readonly player: AmbientPlayer;
  private readonly panel: SoundsPanel;
  /** A volume set here that the extension has not been told about yet. */
  private pendingVolume?: number;
  private volumeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    sources: readonly SoundSource[],
    initial: SoundState,
    private readonly hooks: ReadingSoundsHooks,
  ) {
    this.state = initial;
    this.player = new AmbientPlayer(sources, (id, err) => this.failed(id, err));
    this.panel = new SoundsPanel(sources, {
      choose: (id) => this.choose(id),
      togglePlay: () => this.togglePlay(),
      setVolume: (volume, final) => this.changeVolume(volume, final),
      openChanged: (open) => hooks.openChanged(open),
    });
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
    return { state: this.state, open: this.open, player: this.player.describe() };
  }

  private render(): void {
    this.panel.update(this.state);
    this.hooks.stateChanged(this.state);
  }

  /** Makes the audio match the state: play only in the owner viewer. */
  private sync(): void {
    this.player.setVolume(this.state.volume);
    if (!(this.state.playing && this.state.owner)) {
      this.player.pause();
      return;
    }
    const id = this.state.sound;
    this.player.play(id).catch((err: unknown) => {
      if (this.player.playing === id && !isAbort(err)) this.failed(id, err);
    });
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

  private failed(id: SoundId, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.hooks.log('warn', `Reading sound "${id}" failed: ${message}`);
    this.player.pause();
    this.state = { ...this.state, playing: false, owner: false };
    this.render();
    this.hooks.request({ action: 'failed', message: `${id}: ${message}` });
    this.hooks.notify(`The ${soundLabel(id).toLowerCase()} sound could not be played: ${message}.`);
  }
}
