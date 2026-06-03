/** A cleaned, reader-formatted article extracted from a web page (feature #4). */
export interface ReaderDoc {
  url: string;
  title: string;
  byline?: string;
  siteName?: string;
  publishedAt?: string;
  leadImage?: string;
  /** Sanitized, reader-formatted HTML (allowlist tags only — safe to render). */
  contentHtml: string;
  /** Plain text of the main content, for AI actions. */
  textContent: string;
  wordCount: number;
  estReadMinutes: number;
}

/** AI actions a reader offers on a ReaderDoc's text. */
export type ReaderActionKind = 'summarize' | 'simplify' | 'translate' | 'action_items' | 'ask';

export interface ReaderActionRequest {
  action: ReaderActionKind;
  /** Required for 'translate' (target language) and 'ask' (the question). */
  argument?: string;
}

export interface ReaderActionResult {
  action: ReaderActionKind;
  /** Free-form model output (markdown). For 'action_items' also see `items`. */
  output: string;
  /** Parsed bullet items when action === 'action_items'. */
  items?: string[];
}
