// Reading sounds across viewers. There is one chosen sound and one volume for all viewers, and at
// most one viewer (the owner) produces audio, so opening a second document never doubles the rain.
// Every viewer's controls show this shared state and can change it; playing from a viewer makes
// it the owner. When the owner closes, another open viewer takes over. No vscode imports, so the
// rules can be unit-tested.
import { DEFAULT_SOUND, clampVolume, isSoundId, type SoundId, type SoundRequest, type SoundState } from '../shared/sounds';

export interface SoundViewer {
  /** Sends this viewer its view of the state. */
  postSound(state: SoundState): void;
  readonly isDisposed: boolean;
}

/** Where the chosen sound and volume are remembered (VS Code's global state). */
export interface SoundPrefs {
  get(): unknown;
  set(value: { sound: SoundId; volume: number }): void;
}

const SAVE_DELAY_MS = 400;

export class SoundCoordinator<V extends SoundViewer> {
  private sound: SoundId;
  private volume: number;
  private playing = false;
  private owner?: V;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly prefs: SoundPrefs,
    private readonly viewers: () => Iterable<V>,
    private readonly onPlayingChange: (playing: boolean) => void = () => undefined,
  ) {
    const saved = (prefs.get() ?? {}) as { sound?: unknown; volume?: unknown };
    this.sound = isSoundId(saved.sound) ? saved.sound : DEFAULT_SOUND;
    this.volume = clampVolume(saved.volume);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentOwner(): V | undefined {
    return this.owner && !this.owner.isDisposed ? this.owner : undefined;
  }

  stateFor(viewer: V): SoundState {
    return { sound: this.sound, volume: this.volume, playing: this.playing, owner: this.playing && this.owner === viewer };
  }

  /** A request from a viewer's controls. */
  handle(viewer: V, request: SoundRequest): void {
    switch (request.action) {
      case 'play':
        this.play(viewer, isSoundId(request.sound) ? request.sound : undefined);
        break;
      case 'pause':
        this.pause();
        break;
      case 'volume':
        this.setVolume(request.volume, viewer);
        break;
      case 'failed':
        if (this.owner === viewer && this.playing) this.setPlaying(false);
        else viewer.postSound(this.stateFor(viewer));
        break;
    }
  }

  /** Plays the chosen sound (or `sound`) in `viewer`; any other viewer that was playing stops. */
  play(viewer: V, sound?: SoundId): void {
    const changedSound = sound !== undefined && sound !== this.sound;
    if (sound !== undefined) this.sound = sound;
    this.owner = viewer;
    if (changedSound) this.save(true);
    this.setPlaying(true);
  }

  pause(): void {
    if (this.playing) this.setPlaying(false);
  }

  /** Play/pause for a command: resumes in `viewer`, else in the viewer that played last. */
  toggle(viewer?: V): boolean {
    if (this.playing) {
      this.pause();
      return true;
    }
    const target = viewer ?? this.currentOwner;
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

  /** The owner closed: hand the sound to `next` (another open viewer), or stop. */
  viewerClosed(viewer: V, next?: V): void {
    if (this.owner !== viewer) return;
    this.owner = undefined;
    if (!this.playing) return;
    if (next && next !== viewer && !next.isDisposed) {
      this.owner = next;
      this.broadcast();
    } else {
      this.setPlaying(false);
    }
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.prefs.set({ sound: this.sound, volume: this.volume });
    }
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

  private save(now: boolean): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const write = () => {
      this.saveTimer = undefined;
      this.prefs.set({ sound: this.sound, volume: this.volume });
    };
    if (now) write();
    else this.saveTimer = setTimeout(write, SAVE_DELAY_MS);
  }
}
