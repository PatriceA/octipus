import { describe, expect, it } from 'vitest';
import { INLINE_UI_PROMPT, inlineUiOffered, type InlineUiOfferInput } from './offer';

const base: InlineUiOfferInput = { root: true, audience: 'personal', renders: ['inline_ui'], small: false, cliProvider: false, denied: false };

describe('inlineUiOffered', () => {
  it('offers a personal or space chat only to a client that renders them', () => {
    expect(inlineUiOffered(base)).toBe(true);
    expect(inlineUiOffered({ ...base, audience: 'space' })).toBe(true);
    expect(inlineUiOffered({ ...base, renders: undefined })).toBe(false);
    expect(inlineUiOffered({ ...base, audience: 'space', renders: [] })).toBe(false);
  });

  it('offers a room whatever client asked: members read it in the web app', () => {
    expect(inlineUiOffered({ ...base, audience: 'room', renders: undefined })).toBe(true);
  });

  it('never offers a group thread or a remote-space session', () => {
    expect(inlineUiOffered({ ...base, audience: 'group' })).toBe(false);
    expect(inlineUiOffered({ ...base, audience: 'remote-space' })).toBe(false);
  });

  it('never offers a child, a small model, a CLI root, or a user who denied it', () => {
    for (const off of [{ root: false }, { small: true }, { cliProvider: true }, { denied: true }]) {
      expect(inlineUiOffered({ ...base, audience: 'room', ...off }), JSON.stringify(off)).toBe(false);
      expect(inlineUiOffered({ ...base, ...off }), JSON.stringify(off)).toBe(false);
    }
  });

  it('teaches the fence, the limits and the source tool', () => {
    expect(INLINE_UI_PROMPT).toContain('```octi-ui title=');
    expect(INLINE_UI_PROMPT).toContain('inline-ui__source');
    expect(INLINE_UI_PROMPT).toContain('addEventListener');
  });
});
