// The translate tool in the viewer: the two language menus (in the tool's tray and in the
// result), and the popover that shows a translation while it is made and when it is there.
//   [Japanese (detected) ▾] → [English ▾]                    [copy] [×]
//   In this study, we propose an automatic summary method of Japanese documents…
//   Translated on this computer                           [Save as note]
// The translating itself is the host's (src/translate/): the viewer sends the text and shows what
// comes back.
import { AUTO, languageName, type TranslateLanguage, type TranslationUpdate } from '../src/shared/translate';
import { h, icon, iconButton, labelButton, placeFloating } from './dom';
import { MenuButton } from './menu';

export interface LanguageActions {
  /** The language of the text was picked (`AUTO`: tell it from the text). */
  setFrom(code: string): void;
  /** The language to translate into was picked. */
  setTo(code: string): void;
}

/** The language of the text, an arrow, the language it is translated into: two menus. */
export class LanguagePicker {
  readonly element: HTMLElement;
  private readonly from: MenuButton<string>;
  private readonly to: MenuButton<string>;

  constructor(actions: LanguageActions) {
    this.from = new MenuButton<string>({
      label: 'Translate from',
      className: 'mpv-language-select',
      options: [{ value: AUTO, label: 'Detect language' }],
      onPick: (code) => actions.setFrom(code),
    });
    this.to = new MenuButton<string>({
      label: 'Translate into',
      className: 'mpv-language-select',
      options: [],
      onPick: (code) => actions.setTo(code),
    });
    const arrow = icon('arrow-right');
    arrow.classList.add('mpv-language-arrow');
    this.element = h('div', { class: 'mpv-group mpv-language-picker', role: 'group', 'aria-label': 'Languages' }, this.from.element, arrow, this.to.element);
    this.set(AUTO, 'en');
  }

  setLanguages(languages: TranslateLanguage[]): void {
    this.from.setOptions([{ value: AUTO, label: 'Detect language' }, ...languages.filter((l) => l.from).map((l) => ({ value: l.code, label: l.name }))]);
    this.to.setOptions(languages.filter((l) => l.to).map((l) => ({ value: l.code, label: l.name })));
  }

  /** `detected`: the language the text was found to be in, shown while `from` is "Detect language". */
  set(from: string, to: string, detected?: string): void {
    this.from.setValue(from, languageName(from), from === AUTO && detected ? `${languageName(detected)} (detected)` : undefined);
    this.to.setValue(to, languageName(to));
  }
}

export interface TranslationPopoverActions extends LanguageActions {
  copy(text: string): void;
  /** Keep the translation as the note of a highlight on the text. */
  saveNote(text: string): void;
  /** Ask again (after a download that failed or was declined). */
  retry(): void;
  /** The popover closed (the translation is not waited for any more). */
  closed(): void;
}

const STEP_TEXT = {
  detecting: 'Finding the language…',
  asking: 'Waiting for your answer about the download…',
  downloading: 'Downloading the language pack…',
  translating: 'Translating…',
};

/** `lang` attribute of a language as the packs name it ("zh_hant" is "zh-Hant"). */
function langTag(code: string): string {
  return code === 'zh_hant' ? 'zh-Hant' : code;
}

export class TranslationPopover {
  readonly element: HTMLElement;
  readonly picker: LanguagePicker;
  private readonly status = h('span', { class: 'mpv-translation-status-text' });
  private readonly statusRow = h(
    'div',
    { class: 'mpv-translation-status', role: 'status' },
    h('span', { class: 'mpv-spinner mpv-spinner-sm', 'aria-hidden': 'true' }),
    this.status,
  );
  private readonly text = h('div', { class: 'mpv-translation-text', dir: 'auto', tabindex: 0 });
  private readonly problem = h('span', { class: 'mpv-translation-problem-text' });
  private readonly retry = h('button', { class: 'mpv-link', type: 'button' }, h('span', { class: 'mpv-label', text: 'Try again' }));
  private readonly problemRow = h('div', { class: 'mpv-translation-problem', role: 'alert', hidden: true }, icon('info'), this.problem, this.retry);
  private readonly footnote = h('span', { class: 'mpv-hint mpv-translation-footnote' });
  private readonly copy = iconButton('copy', 'Copy the translation');
  private readonly note = labelButton(icon('comment'), 'Save as note', 'Highlight the text and keep this translation as its note');
  private readonly footer: HTMLElement;
  private anchor: [number, number] = [0, 0];
  private translated = '';
  private noteAllowed = true;

  constructor(private readonly actions: TranslationPopoverActions) {
    this.picker = new LanguagePicker(actions);
    const close = iconButton('close', 'Close (Esc)');
    close.addEventListener('click', () => this.hide());
    this.copy.addEventListener('click', () => {
      if (this.translated) actions.copy(this.translated);
    });
    this.note.addEventListener('click', () => {
      if (this.translated) actions.saveNote(this.translated);
    });
    this.retry.addEventListener('click', () => actions.retry());
    this.footer = h('div', { class: 'mpv-popover-row mpv-translation-footer' }, this.footnote, h('span', { class: 'mpv-grow' }), this.note);
    this.element = h(
      'div',
      { class: 'mpv-popover mpv-translation', role: 'dialog', 'aria-label': 'Translation', hidden: true },
      h('div', { class: 'mpv-popover-row mpv-translation-head' }, this.picker.element, h('span', { class: 'mpv-grow' }), this.copy, close),
      this.statusRow,
      this.problemRow,
      this.text,
      this.footer,
    );
    document.body.append(this.element);
  }

  /** Opens at a point of the screen, waiting for a translation. */
  open(x: number, y: number): void {
    this.anchor = [x, y];
    this.restart();
  }

  /** Waits for a translation again (another language was picked): what it showed is gone. */
  restart(): void {
    this.translated = '';
    this.text.textContent = '';
    this.text.hidden = true;
    this.problemRow.hidden = true;
    this.footer.hidden = true;
    this.copy.disabled = true;
    this.statusRow.hidden = false;
    this.status.textContent = STEP_TEXT.translating;
    this.place();
  }

  /**
   * What the "Save as note" button does here, or undefined when it has no place: 'new' makes a
   * highlight of the text with the translation as its note, 'add' puts it in the note of the
   * highlight that was translated.
   */
  setNoteTarget(target: 'new' | 'add' | undefined): void {
    this.noteAllowed = target !== undefined;
    const title = target === 'add' ? 'Keep this translation in the note of the highlight' : 'Highlight the text and keep this translation as its note';
    this.note.title = title;
    this.note.setAttribute('aria-label', title);
    this.note.hidden = !this.noteAllowed;
  }

  /** How the request goes, and its result. */
  update(update: TranslationUpdate): void {
    if (this.element.hidden) return;
    if (update.status === 'working') {
      const percent = update.step === 'downloading' && update.progress !== undefined ? ` ${Math.round(update.progress * 100)}%` : '';
      this.status.textContent = `${STEP_TEXT[update.step]}${percent}`;
      this.statusRow.hidden = false;
      this.problemRow.hidden = true;
      if (update.text) this.showText(update.text, update.to, true);
    } else if (update.status === 'done') {
      this.statusRow.hidden = true;
      this.problemRow.hidden = true;
      this.showText(update.text, update.to, false);
      this.translated = update.text;
      this.copy.disabled = false;
      this.footnote.textContent = update.pivot ? 'Translated on this computer, by way of English' : 'Translated on this computer';
      this.note.hidden = !this.noteAllowed;
      this.footer.hidden = false;
    } else {
      this.statusRow.hidden = true;
      this.text.hidden = true;
      this.footer.hidden = true;
      this.copy.disabled = true;
      this.translated = '';
      this.problem.textContent = update.message;
      // Asking again helps where the answer may be another one: the download.
      this.retry.hidden = update.problem !== 'declined' && update.problem !== 'download-failed' && update.problem !== 'failed';
      this.problemRow.hidden = false;
    }
    this.place();
  }

  private showText(text: string, to: string, partial: boolean): void {
    this.text.textContent = text;
    this.text.lang = langTag(to);
    this.text.classList.toggle('mpv-translation-partial', partial);
    this.text.hidden = false;
  }

  /** Under the point it was opened at, inside the window (again whenever what it holds grows). */
  private place(): void {
    placeFloating(this.element, this.anchor[0], this.anchor[1]);
  }

  hide(): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.actions.closed();
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  contains(node: Node | null): boolean {
    return !!node && this.element.contains(node);
  }
}
