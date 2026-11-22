/**
 * The alternate screen's transcript search, finished: Escape puts the
 * reading position back where it was when the search opened, as a pager
 * does; the search key pressed again closes it and stays on the match.
 *
 * pi-tui's search (`tui.altScreen.search`, Ctrl+Shift+F) already finds,
 * counts and highlights matches and moves between them (Enter / Shift+Enter,
 * Ctrl+G / Ctrl+Shift+G). Its close leaves the view on the last match
 * whichever way it was closed. The methods involved are private in pi-tui,
 * so this reaches them by name, on this exact pinned version, and fails
 * loudly at startup if they are not there — an upgrade that renames them
 * breaks the launch and `transcript-search.test.ts`, not the user's place.
 */
import type { ScrollView, TuiAltScreen } from '@earendil-works/pi-tui';

interface SearchInternals {
  toggleSearch(): void;
  closeSearch(): void;
  activeSearch?: unknown;
  getPrimaryScrollView(): ScrollView;
}

export interface TranscriptSearch {
  /** Open the search (or close it, staying on the match), as the search key does. */
  toggle(): void;
  isOpen(): boolean;
}

export function installTranscriptSearch(tui: TuiAltScreen): TranscriptSearch {
  const internals = tui as unknown as SearchInternals;
  for (const name of ['toggleSearch', 'closeSearch', 'getPrimaryScrollView'] as const) {
    if (typeof internals[name] !== 'function') throw new Error(`pi-tui's alternate screen has no ${name}(); transcript search needs updating for this pi-tui version`);
  }
  const toggle = internals.toggleSearch.bind(tui);
  const close = internals.closeSearch.bind(tui);
  let opened: { top: number; following: boolean } | null = null;
  let stay = false;

  internals.toggleSearch = () => {
    if (internals.activeSearch) {
      stay = true;
      try { toggle(); } finally { stay = false; }
      return;
    }
    const view = internals.getPrimaryScrollView();
    opened = { top: view.scrollTop, following: view.isFollowingEnd };
    toggle();
  };
  internals.closeSearch = () => {
    const wasOpen = Boolean(internals.activeSearch);
    close();
    const back = opened;
    opened = null;
    if (!wasOpen || stay || !back) return;
    const view = internals.getPrimaryScrollView();
    if (back.following) view.scrollToEnd();
    else view.scrollTo(back.top);
    tui.requestRender();
  };
  return { toggle: () => internals.toggleSearch(), isOpen: () => Boolean(internals.activeSearch) };
}
