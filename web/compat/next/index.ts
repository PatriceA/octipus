/**
 * The two document-metadata types the root layout annotated itself with.
 * Kept as types only: the metadata itself now lives in `index.html`.
 */
export interface Metadata {
  title?: string;
  description?: string;
  manifest?: string;
  icons?: unknown;
  appleWebApp?: unknown;
}

export interface Viewport {
  themeColor?: string;
}
