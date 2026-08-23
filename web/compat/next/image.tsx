/**
 * `<Image>` as a plain `<img>`. The one caller renders a static asset from
 * `public/`, so the optimisation pipeline the framework's component wraps was
 * never doing anything here.
 */
import type { ImgHTMLAttributes } from 'react';

export interface ImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  alt: string;
  width?: number | string;
  height?: number | string;
  priority?: boolean;
  unoptimized?: boolean;
}

export default function Image({ priority: _p, unoptimized: _u, ...rest }: ImageProps) {
  // biome-ignore lint/a11y/useAltText: `alt` is required by the props type.
  return <img {...rest} />;
}
