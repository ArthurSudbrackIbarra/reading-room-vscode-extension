// Reading sounds across viewers. There is one chosen sound and one volume for all viewers, and at
// most one viewer (the owner) produces audio, so opening a second document never doubles the rain.
// Every viewer's controls show this shared state and can change it; playing from a viewer makes
// it the owner. When the owner closes, another open viewer takes over. VS Code lets a viewer start
// sound only once the reader has clicked in it, so a viewer that has had a click ("ready") is
// preferred whenever the extension picks one. Each category (rain, fireplace, custom) remembers
// which of its recordings its tile plays. No vscode imports, so the rules can be unit-tested.
import {
  DEFAULT_CHOICES,
  DEFAULT_SOUND,
  SOUND_CATEGORIES,
  categoryOf,
  clampVolume,
  migrateSoundId,
  type SoundCategory,
  type SoundChoices,
  type SoundRequest,
  type SoundState,
} from '../shared/sounds';

export interface SoundViewer {
  /** Sends this viewer its view of the state. */
  postSound(state: SoundState): void;
  readonly isDisposed: boolean;
}

/** Where the chosen sounds and volume are remembered (VS Code's global state). */
export interface SoundPrefs {
  get(): unknown;
  set(value: { sound: string; volume: number; choices: SoundChoices }): void;
}

/** A sound that can be played now: the built-in ones in this build, and the reader's own. */
export interface SoundEntry {
  id: string;
  category: SoundCategory;
}

const SAVE_DELAY_MS = 400;

export class SoundCoordinator<V extends SoundViewer> {
  private sound: string;
  private choices: SoundChoices;
  private volume: number;
  private playing = false;
  private owner?: V;
  /** Viewers that may start sound without another click (see SoundRequest 'ready'). */
  private readonly ready = new WeakSet<V>();
  /** The custom sounds have been loaded: from then on, a custom id that is not among them is gone. */
  private customLoaded = false;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly prefs: SoundPrefs,
    private readonly viewers: () => Iterable<V>,
    private readonly catalog: () => readonly SoundEntry[],
    private readonly onPlayingChange: (playing: boolean) => void = () => undefined,
  ) {
    const saved = (prefs.get() ?? {}) as { sound?: unknown; volume?: unknown; choices?: unknown };
    this.volume = clampVolume(saved.volume);
    const savedChoices = (saved.choices && typeof saved.choices === 'object' ? saved.choices : {}) as Record<string, unknown>;
    this.choices = { ...DEFAULT_CHOICES };
    // Custom sounds may not be loaded yet; ids that look right are kept until catalogChanged().
    for (const category of SOUND_CATEGORIES) {
      const id = migrateSoundId(savedChoices[category]);
      if (id && categoryOf(id) === category) this.choices[category] = id;
    }
    const sound = migrateSoundId(saved.sound);
    const category = sound ? categoryOf(sound) : undefined;
    this.sound = sound && category ? sound : DEFAULT_SOUND;
    // 0.3 saved only the sound: it is also its category's choice.
    if (sound && category && !saved.choices) this.choices[category] = sound;
    this.validate();
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentOwner(): V | undefined {
    return this.owner && !this.owner.isDisposed ? this.owner : undefined;
  }

  stateFor(viewer: V): SoundState {
    return {
      sound: this.sound,
      choices: { ...this.choices },
      volume: this.volume,
      playing: this.playing,
      owner: this.playing && this.owner === viewer,
    };
  }

  /** A request from a viewer's controls (the custom-sound requests are the extension's business). */
  handle(viewer: V, request: SoundRequest): void {
    switch (request.action) {
      case 'play':
        if (this.has(request.sound)) this.play(viewer, request.sound);
        else viewer.postSound(this.stateFor(viewer));
        break;
      case 'pause':
        this.pause();
        break;
      case 'volume':
        this.setVolume(request.volume, viewer);
        break;
      case 'ready':
        this.ready.add(viewer);
        break;
      case 'failed':
        if (this.owner === viewer && this.playing) this.setPlaying(false);
        else viewer.postSound(this.stateFor(viewer));
        break;
    }
  }

  /** Plays the chosen sound (or `sound`, which becomes its category's choice) in `viewer`; any other viewer that was playing stops. */
  play(viewer: V, sound?: string): void {
    if (sound !== undefined) {
      const category = categoryOf(sound);
      const changed = sound !== this.sound || (category !== undefined && this.choices[category] !== sound);
      this.sound = sound;
      if (category) this.choices[category] = sound;
      if (changed) this.save(true);
    }
    this.owner = viewer;
    this.setPlaying(true);
  }

  pause(): void {
    if (this.playing) this.setPlaying(false);
  }

  /** Makes `sound` its category's choice without playing it (a sound the reader just added). */
  choose(sound: string): void {
    const category = categoryOf(sound);
    if (!category || !this.has(sound) || this.choices[category] === sound) return;
    this.choices[category] = sound;
    this.save(true);
    this.broadcast();
  }

  /**
   * Play/pause for a command. Resumes in `preferred` (the active viewer) or the viewer that played
   * last, unless only another viewer can start sound without a click. False when no viewer is open.
   */
  toggle(preferred?: V): boolean {
    if (this.playing) {
      this.pause();
      return true;
    }
    const target = this.pick([preferred, this.currentOwner]);
    if (!target) return false;
    this.play(target);
    return true;
  }

  setVolume(volume: unknown, from?: V): void {
    const value = clampVolume(volume, this.volume);
    if (value === this.volume) return;
    this.volume = value;
    this.save(false);
    // The viewer that moved the slider already applied it.
    this.broadcast(from);
  }

  /**
   * The sounds on offer changed (the custom sounds were loaded, added or removed). Choices of
   * sounds that are gone fall back to another sound of their category; if the sound that was
   * playing is gone, it stops.
   */
  catalogChanged(): void {
    this.customLoaded = true;
    const before = JSON.stringify([this.sound, this.choices]);
    const wasPlaying = this.playing;
    if (this.validate() && this.playing) this.playing = false;
    if (JSON.stringify([this.sound, this.choices]) !== before) this.save(true);
    this.broadcast();
    if (wasPlaying && !this.playing) this.onPlayingChange(false);
  }

  /** A viewer closed. If it was playing, another open viewer takes over (`preferred` if it can); with none left, the sound stops. */
  viewerClosed(viewer: V, preferred?: V): void {
    if (this.owner !== viewer) return;
    this.owner = undefined;
    if (!this.playing) return;
    const next = this.pick([preferred], viewer);
    if (next) {
      this.owner = next;
      this.broadcast();
    } else {
      this.setPlaying(false);
    }
  }

  /** A viewer (re)loaded its page: the new page has had no click yet. */
  pageLoaded(viewer: V): void {
    this.ready.delete(viewer);
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.write();
    }
  }

  private has(id: string): boolean {
    return this.catalog().some((e) => e.id === id);
  }

  /**
   * Points choices and the sound at sounds that exist: a missing choice becomes its category's
   * default (or first) sound; a missing custom choice another custom sound, if any. Custom ids
   * are left alone until the custom sounds are known. True when the current sound was replaced.
   */
  private validate(): boolean {
    const entries = this.catalog();
    const known = new Set(entries.map((e) => e.id));
    const customKnown = this.customLoaded;
    for (const category of SOUND_CATEGORIES) {
      const id = this.choices[category];
      if (id !== undefined && known.has(id)) continue;
      if (category === 'custom' && id !== undefined && !customKnown) continue;
      const fallback = DEFAULT_CHOICES[category];
      this.choices[category] = fallback && known.has(fallback) ? fallback : entries.find((e) => e.category === category)?.id;
    }
    if (known.has(this.sound) || (categoryOf(this.sound) === 'custom' && !customKnown)) return false;
    const category = categoryOf(this.sound);
    this.sound = (category && this.choices[category]) ?? this.choices.rain ?? entries[0]?.id ?? DEFAULT_SOUND;
    return true;
  }

  /**
   * The viewer to play in: the first of `preferred` that may start sound on its own, else any
   * open viewer that may, else the first preferred one (it starts at the reader's next click).
   */
  private pick(preferred: (V | undefined)[], exclude?: V): V | undefined {
    const open = (v: V | undefined): v is V => v !== undefined && v !== exclude && !v.isDisposed;
    const candidates = [...preferred.filter(open), ...[...this.viewers()].filter(open)];
    return candidates.find((v) => this.ready.has(v)) ?? candidates[0];
  }

  private setPlaying(playing: boolean): void {
    const changed = playing !== this.playing;
    this.playing = playing;
    this.broadcast();
    if (changed) this.onPlayingChange(playing);
  }

  private broadcast(except?: V): void {
    for (const viewer of this.viewers()) {
      if (viewer !== except && !viewer.isDisposed) viewer.postSound(this.stateFor(viewer));
    }
  }

  private write(): void {
    this.prefs.set({ sound: this.sound, volume: this.volume, choices: { ...this.choices } });
  }

  private save(now: boolean): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const write = () => {
      this.saveTimer = undefined;
      this.write();
    };
    if (now) write();
    else this.saveTimer = setTimeout(write, SAVE_DELAY_MS);
  }
}
