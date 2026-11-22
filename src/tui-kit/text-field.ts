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
    // Input draws a "> " prompt; the overlay's own label takes its place.
    const row = this.input.render(width + 2)[0] ?? '';
    const shown = row.startsWith('> ') ? row.slice(2) : row;
    return focused || visibleWidth(shown) > 0 ? shown : placeholder;
  }
}
