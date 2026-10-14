'use client';

/**
 * Interactive answers in a timeline (docs/plans/inline-ui-spec.md). The page
 * that shows a conversation — the chat, a room — says how to fetch a block,
 * whether the conversation is shared, which blocks arrived live, and what the
 * buttons a block draws do. Without a provider, markers render as their plain
 * line (any other use of the timeline).
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { InlineUiReport } from '../../../../src/shared/inline-ui/bridge';

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
  /** A turn is running: Send steers it (labelled so). */
  busy?: boolean;
  /** Keep the block as a live artifact (P3). */
  saveAsArtifact?: (blockId: string, title: string) => void;
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

/** `attempt` changes on Retry, after `forgetInlineUiBlock`, to fetch again. */
export function useInlineUiBlockFetch(host: InlineUiHost | null, id: string, attempt = 0): Promise<InlineUiBlockData> | null {
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
    // `attempt` is a dependency on purpose: Retry runs this again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, id, attempt]);
}

export function forgetInlineUiBlock(host: InlineUiHost, id: string): void {
  cache.delete(`${host.key}:${id}`);
}
