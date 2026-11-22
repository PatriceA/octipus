/**
 * The one text field the editor's overlays use (find, replace, file filter,
 * Save As): pi-tui's `Input`, so a field takes a paste, an emoji, IME
 * composition and kitty-encoded keys like the chat composer does, with
 * cursor movement and word deletion. The overlay keeps the keys it handles
 * itself (Enter, Escape, Tab, its toggles) and passes the rest here.
 */
import { Input, visibleWidth } from '@earendil-works/pi-tui';

export class TextField {
  private readonly input = new Input();

  constructor(value = '') {
    if (value) this.setValue(value);
  }

  get value(): string { return this.input.getValue(); }

  /** Replace the text and put the cursor at its end. */
  setValue(value: string): void {
    this.input.setValue(value);
    // `setValue` keeps the old cursor; End moves it after the text.
    this.input.handleInput('\x1b[F');
  }

  /** Feed a key; returns whether the text changed. */
  handleInput(data: string): boolean {
    const before = this.input.getValue();
    this.input.handleInput(data);
    return this.input.getValue() !== before;
  }

  /** One row: the text with a cursor when `focused`, `placeholder` when empty and unfocused. */
  render(width: number, focused: boolean, placeholder = ''): string {
    if (!focused && this.value === '') return placeholder;
    this.input.focused = focused;
    // The value can hold control bytes (a file name prefilled for rename or Save As): Input would write them
    // to the terminal as they are. Drawn as control pictures, one code unit for one, so the cursor stays put.
    const value = this.input.getValue();
    const shown = controlPictures(value);
    if (shown !== value) this.input.setValue(shown);
    // Input draws a "> " prompt; the overlay's own label takes its place.
    let row: string;
    try { row = this.input.render(width + 2)[0] ?? ''; } finally { if (shown !== value) this.input.setValue(value); }
    const drawn = row.startsWith('> ') ? row.slice(2) : row;
    return focused || visibleWidth(drawn) > 0 ? drawn : placeholder;
  }
}

/** C0 controls, DEL and C1 controls as visible one-unit characters (␛, ␇, ␉, ␡, �). */
function controlPictures(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => (c === '\x7f' ? '\u2421' : c > '\x7f' ? '\ufffd' : String.fromCharCode(0x2400 + c.charCodeAt(0))));
}
