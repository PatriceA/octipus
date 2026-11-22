'use client';

/**
 * Interactive answers in a timeline (docs/plans/inline-ui-spec.md). The page
 * that shows a conversation — the chat, a room — says how to fetch a block,
 * whether the conversation is shared, which blocks arrived live, and what the
 * buttons a block draws do. Without a provider, markers render as their plain
 * line (any other use of the timeline).
 */
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { InlineUiReport } from '../../../../src/shared/inline-ui/bridge';
import type { InlineUiView, InlineUiViewAction, InlineUiViewState, JsonObject } from '../../../../src/shared/inline-ui/view';

export interface InlineUiBlockData {
  id: string;
  title: string;
  heightHint: number;
  css: string;
  html: string;
  js: string;
  scripts: boolean;
  tainted: boolean;
  risk: 'normal' | 'high';
  issues: string[];
  /** Read by more people than the one who asked (a room). */
  shared?: boolean;
  /** `view`: a declarative view (docs/plans/inline-ui-views-spec.md). A server from before views omits it: HTML. */
  kind?: 'html' | 'view';
  /** The normalized view, for `kind: 'view'`. */
  view?: InlineUiView | null;
  /** A view's last answer, if one was sent. */
  state?: InlineUiViewState | null;
}

/** An answer from a view's button (spec §4): `inlineUi.action` plus the data model at the click and the message text. */
export interface InlineUiSendAction extends InlineUiViewAction {
  /** Left out when it is over `INLINE_UI_VIEW_LIMITS.dataChars`: the server then keeps the view's own data. */
  data?: JsonObject;
  /** The message as the conversation shows it: the event's `userMessage`, or the button's label. */
  text: string;
}

export interface InlineUiHost {
  /** Identifies the conversation: blocks are cached per key. */
  key: string;
  fetchBlock: (id: string) => Promise<InlineUiBlockData>;
  /** A shared conversation (a room): scripts wait for a click. */
  shared: boolean;
  /** The block arrived in a reply received while this page was open (not from history). */
  isLive: (id: string) => boolean;
  /** An admin acting as this user: scripts wait for a click, and suggestions are off. */
  impersonating: boolean;
  /** Something happened to a block that the model should hear with the next message (G3). */
  report?: (report: InlineUiReport) => void;
  /** Send a suggested message as the user's own (they clicked Send in the strip). */
  sendSuggestion?: (text: string, blockId: string) => void;
  /** Put a suggested message in the composer, after what is there. */
  editSuggestion?: (text: string, blockId: string) => void;
  /**
   * Send a view's answer as the user's own message. Resolves once it went
   * out, rejects with the reason it could not; a refusal the server sends
   * afterwards arrives through `onRefused`.
   */
  sendAction?: (action: InlineUiSendAction, onRefused: (message: string) => void) => void | Promise<void>;
  /** A turn is running: Send steers it (labelled so). */
  busy?: boolean;
  /** Keep the block as a live artifact (P3): a static copy in the user's workspace. */
  saveAsArtifact?: (blockId: string, input: SaveAsArtifactInput) => Promise<SaveAsArtifactResult>;
}

export interface SaveAsArtifactInput {
  title: string;
  slug: string;
  visibility: 'private' | 'workspace';
}

export interface SaveAsArtifactResult {
  /** Where the artifact opens in the app. */
  appUrl: string;
  /** The script did not build, and so on: the copy was saved anyway. */
  warnings: string[];
}

const InlineUiContext = createContext<InlineUiHost | null>(null);

export function InlineUiProvider({ host, children }: { host: InlineUiHost | null; children: ReactNode }) {
  return <InlineUiContext.Provider value={host}>{children}</InlineUiContext.Provider>;
}

export function useInlineUiHost(): InlineUiHost | null {
  return useContext(InlineUiContext);
}

/** One fetch per block per conversation, shared by every render of it. */
const cache = new Map<string, Promise<InlineUiBlockData>>();

/**
 * How often a block was fetched again because it changed elsewhere (a view
 * answered in another tab or by another member): a block whose revision
 * moves on while it is shown fetches again and draws the new state.
 */
const revisions = new Map<string, number>();
const revisionListeners = new Set<() => void>();

function subscribeRevisions(listener: () => void): () => void {
  revisionListeners.add(listener);
  return () => { revisionListeners.delete(listener); };
}

/** `attempt` changes on Retry, after `forgetInlineUiBlock`, to fetch again. */
export function useInlineUiBlockFetch(host: InlineUiHost | null, id: string, attempt = 0): Promise<InlineUiBlockData> | null {
  const revision = useInlineUiBlockRevision(host, id);
  return useMemo(() => {
    if (!host) return null;
    const key = `${host.key}:${id}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = host.fetchBlock(id);
      // A failed fetch is not cached: Retry fetches again.
      pending.catch(() => cache.delete(key));
      cache.set(key, pending);
    }
    return pending;
    // `attempt` and `revision` are dependencies on purpose: Retry and a refresh run this again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, id, attempt, revision]);
}

/** The block's revision: it moves on when `refreshInlineUiBlock` is called for it. */
export function useInlineUiBlockRevision(host: InlineUiHost | null, id: string): number {
  const key = host ? `${host.key}:${id}` : '';
  return useSyncExternalStore(subscribeRevisions, () => revisions.get(key) ?? 0, () => 0);
}

export function forgetInlineUiBlock(host: InlineUiHost, id: string): void {
  cache.delete(`${host.key}:${id}`);
}

/**
 * The block changed on the server outside this tab's own answer (another tab
 * or another member answered a view): drop the cached copy and have a block
 * that shows it fetch again.
 */
export function refreshInlineUiBlock(hostKey: string, id: string): void {
  const key = `${hostKey}:${id}`;
  cache.delete(key);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  for (const listener of revisionListeners) listener();
}

/**
 * This tab answered a view (or the server refused the answer): the cached
 * copy carries the state the block shows now, so a block mounted again later
 * (back from another session) opens as it was left, not as first fetched.
 */
export function setCachedInlineUiState(host: InlineUiHost, id: string, state: InlineUiViewState | null): void {
  const key = `${host.key}:${id}`;
  const pending = cache.get(key);
  if (!pending) return;
  const next = pending.then((block) => ({ ...block, state }));
  next.catch(() => cache.delete(key));
  cache.set(key, next);
}
