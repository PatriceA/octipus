/**
 * The pi-tui pieces the file editor uses beyond what `index.ts` re-exports:
 * decoding a printable key sent as a kitty CSI-u sequence, and fuzzy
 * matching for the file picker. Same seam rule as `index.ts`: add a name
 * when a caller needs it.
 */
export { decodeKittyPrintable, fuzzyMatch } from '@mariozechner/pi-tui';
