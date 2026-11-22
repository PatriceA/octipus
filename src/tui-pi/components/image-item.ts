/**
 * An image attached to a message, in the transcript: drawn where the
 * terminal draws images, otherwise one dim line naming it (`TerminalImage`).
 */
import { TerminalImage } from '@/tui-kit/images';
import { displayLine } from '@/tui-kit';
import { chalk, getPalette } from '../theme/defaults';

export interface ImageItem {
  kind: 'image';
  name: string;
  mimeType: string;
  /** Base64. */
  data: string;
}

const drawn = new WeakMap<ImageItem, TerminalImage>();

export function renderImageItem(item: ImageItem, width: number): string[] {
  let image = drawn.get(item);
  if (!image) {
    image = new TerminalImage(item.data, item.mimeType, displayLine(item.name), text => chalk.hex(getPalette().dim)(text));
    drawn.set(item, image);
  }
  // Two cells in, like every transcript row (the rail).
  return image.render(Math.max(3, width - 2)).map(line => `  ${line}`);
}
