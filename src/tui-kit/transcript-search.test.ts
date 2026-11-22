import { describe, expect, test, vi } from 'vitest';
import { TuiAltScreen } from '@earendil-works/pi-tui';
import { installTranscriptSearch } from './transcript-search';

/** Stands in for the alternate screen: its search opens and closes the way pi-tui's does. */
function fakeScreen() {
  const view = { scrollTop: 40, isFollowingEnd: false, scrollTo: vi.fn((top: number) => { view.scrollTop = top; }), scrollToEnd: vi.fn() };
  interface Screen { activeSearch?: object; requestRender: () => void; getPrimaryScrollView: () => typeof view; toggleSearch(): void; closeSearch(): void }
  const screen: Screen = {
    activeSearch: undefined,
    requestRender: vi.fn(),
    getPrimaryScrollView: () => view,
    toggleSearch(this: Screen) { if (this.activeSearch) { this.closeSearch(); return; } this.activeSearch = {}; },
    closeSearch(this: Screen) { this.activeSearch = undefined; },
  };
  return { screen, view, search: installTranscriptSearch(screen as unknown as TuiAltScreen) };
}

describe('transcript search', () => {
  test('Escape returns to where reading was when the search opened', () => {
    const { screen, view, search } = fakeScreen();
    search.toggle();
    expect(search.isOpen()).toBe(true);
    view.scrollTop = 3; // the search moved to a match
    screen.closeSearch(); // what pi-tui's Escape binding calls
    expect(view.scrollTo).toHaveBeenCalledWith(40);
    expect(search.isOpen()).toBe(false);
  });

  test('following the latest when it opened: Escape follows it again', () => {
    const { view, search, screen } = fakeScreen();
    view.isFollowingEnd = true;
    search.toggle();
    screen.closeSearch();
    expect(view.scrollToEnd).toHaveBeenCalled();
  });

  test('the search key again closes it and stays on the match', () => {
    const { view, search } = fakeScreen();
    search.toggle();
    view.scrollTop = 3;
    search.toggle();
    expect(search.isOpen()).toBe(false);
    expect(view.scrollTo).not.toHaveBeenCalled();
    expect(view.scrollTop).toBe(3);
  });

  test('the pinned pi-tui still has the methods this reaches', () => {
    for (const name of ['toggleSearch', 'closeSearch', 'getPrimaryScrollView']) {
      expect(typeof (TuiAltScreen.prototype as unknown as Record<string, unknown>)[name]).toBe('function');
    }
    expect(() => installTranscriptSearch({} as TuiAltScreen)).toThrow(/no toggleSearch/);
  });
});
