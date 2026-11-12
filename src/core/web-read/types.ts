/**
 * A clean article extracted from a public web page: what the plugin host
 * scope `web:read` hands a package (src/api/routes/plugin-host.ts).
 */
export interface WebArticle {
  url: string;
  title: string;
  byline?: string;
  siteName?: string;
  publishedAt?: string;
  leadImage?: string;
  /** Sanitized article HTML (allowlist tags only — safe to render). */
  contentHtml: string;
  /** Plain text of the main content. */
  textContent: string;
  wordCount: number;
  estReadMinutes: number;
}
