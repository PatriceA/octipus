/**
 * Older turns of a session, loaded from the server as the reader scrolls up.
 *
 * The transcript starts with what the gateway's `/history` replays (the
 * newest 50 user and assistant messages, each with its id). Older ones come
 * a page at a time from the REST route the web pages its history with,
 * `GET /sessions/:id/messages?page=true&before=<id>`, as the signed-in user.
 * The pane says when it reaches its top (`onReachTop`); this puts the page
 * above what is there and keeps the cursor: the oldest id loaded.
 */
import type { ChatMessage, MessagesPane } from './components/messages-pane';

/** A message as `/history` sends it. */
export interface HistoryRow { id?: string; role: 'user' | 'assistant'; content: string; at: string }

export const isHistoryRow = (v: unknown): v is HistoryRow => {
  const r = v as HistoryRow | null;
  return !!r && (r.role === 'user' || r.role === 'assistant') && typeof r.content === 'string';
};

/** One page of `GET /sessions/:id/messages?page=true`, the fields read here. */
interface HistoryPage {
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
  hasMore: boolean;
}

/** Messages per page: the route's maximum. */
export const OLDER_PAGE = 100;
/** After a failed load, a scroll up asks again no sooner than this; it doubles with each failure in a row, up to `RETRY_MAX_MS`. */
export const RETRY_MS = 3000;
const RETRY_MAX_MS = 60_000;

export const toChatMessage = (row: HistoryRow): ChatMessage => ({ role: row.role, content: row.content, timestamp: new Date(row.at) });

export class OlderTurns {
  /** The oldest message loaded from the server: the next page ends just before it. */
  private cursor: string | null = null;
  /** Bumped by every replay and reset: a page that arrives for an older one is dropped. */
  private generation = 0;
  private loading = false;
  private failedAt = 0;
  private failures = 0;

  constructor(
    private readonly pane: MessagesPane,
    private readonly getJson: <T>(path: string) => Promise<T>,
    private readonly sessionId: () => string,
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {
    pane.onReachTop = () => { void this.load(); };
  }

  /**
   * The transcript was replaced by a replay of `rows` (oldest first). With
   * any, older ones may be on the server; with none the session is empty.
   */
  replayed(rows: readonly HistoryRow[]): void {
    this.generation++;
    this.loading = false;
    this.failures = 0;
    this.cursor = rows.find(row => typeof row.id === 'string')?.id ?? null;
    this.pane.setOlder({ state: this.cursor ? 'more' : 'none' });
  }

  /** The transcript was cleared or moved to another session: nothing to page. */
  reset(): void {
    this.generation++;
    this.loading = false;
    this.cursor = null;
  }

  /** Load the page before the cursor and put it above the transcript. */
  async load(): Promise<void> {
    if (this.loading || !this.cursor) return;
    if (this.pane.getOlder().state === 'failed' && this.now() - this.failedAt < Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (this.failures - 1))) return;
    const generation = this.generation;
    const sessionId = this.sessionId();
    this.loading = true;
    this.pane.setOlder({ state: 'loading' });
    this.changed();
    let page: HistoryPage;
    try {
      const query = new URLSearchParams({ page: 'true', limit: String(OLDER_PAGE), before: this.cursor, roles: 'user,assistant', aggregate: 'false' });
      page = await this.getJson<HistoryPage>(`/sessions/${encodeURIComponent(sessionId)}/messages?${query}`);
      if (!Array.isArray(page?.messages)) throw new Error('the server sent no messages');
    } catch (error) {
      if (generation !== this.generation) return;
      this.loading = false;
      this.failedAt = this.now();
      this.failures++;
      this.pane.setOlder({ state: 'failed', reason: error instanceof Error ? error.message : String(error) });
      this.changed();
      return;
    }
    if (generation !== this.generation) return;
    this.loading = false;
    this.failures = 0;
    this.cursor = page.messages[0]?.id ?? null;
    const rows = page.messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map(m => toChatMessage({ role: m.role as HistoryRow['role'], content: m.content, at: m.createdAt }));
    this.pane.prependMessages(rows);
    this.pane.setOlder({ state: page.hasMore && this.cursor ? 'more' : 'none' });
    this.changed();
  }
}
