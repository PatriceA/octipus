/**
 * Images drawn in the terminal where it can (pi-tui's Kitty graphics and
 * iTerm2 inline image support), a one-line text description where it cannot.
 *
 * pi-tui picks the protocol from the terminal it detects (kitty, Ghostty,
 * WezTerm, Warp: Kitty graphics; iTerm2: its own) and falls back to text —
 * file name, type and size — everywhere else, tmux included.
 */
import { getCapabilities, Image } from '@earendil-works/pi-tui';

/** Which protocol images are drawn with here, or null when they are described in text. */
export function imageProtocol(): 'kitty' | 'iterm2' | null {
  return getCapabilities().images;
}

/** An image as transcript rows: the picture where the terminal draws one, else its text fallback. */
export class TerminalImage {
  private readonly image: Image;
  constructor(base64: string, mimeType: string, name: string, fallbackStyle: (text: string) => string, maxRows = 12) {
    this.image = new Image(base64, mimeType, { fallbackColor: fallbackStyle }, { filename: name, maxHeightCells: maxRows, maxWidthCells: 60 });
  }
  render(width: number): readonly string[] { return this.image.render(width); }
  invalidate(): void { this.image.invalidate(); }
}
