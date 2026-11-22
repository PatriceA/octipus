import { describe, expect, it } from 'vitest';
import { withoutOffModules } from '@/core/modules/prompt';
import { findInlineUiFences, isInlineUiViewBody, lintInlineUiView } from '@/shared/inline-ui';
import { estimateTokens } from '@/utils/token-count';
import { INLINE_UI_PROMPT_EXAMPLES, INTERACTIVE_ANSWER_SETTINGS, inlineUiOffered, inlineUiPrompt, type InlineUiOfferInput } from './offer';

const base: InlineUiOfferInput = { root: true, audience: 'personal', renders: ['inline_ui'], small: false, denied: false, setting: 'auto' };

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

  it('never offers a child, a small model, a user who denied it, or an install that set it off', () => {
    for (const off of [{ root: false }, { small: true }, { denied: true }, { setting: 'off' as const }]) {
      expect(inlineUiOffered({ ...base, audience: 'room', ...off }), JSON.stringify(off)).toBe(false);
      expect(inlineUiOffered({ ...base, ...off }), JSON.stringify(off)).toBe(false);
    }
  });

  it('auto and prefer offer exactly where the rest of the matrix does', () => {
    for (const setting of ['auto', 'prefer'] as const) {
      for (const audience of ['personal', 'space', 'room', 'group', 'remote-space'] as const) {
        for (const renders of [undefined, ['inline_ui']]) {
          const input = { ...base, audience, renders, setting };
          const expected = audience === 'room' || ((audience === 'personal' || audience === 'space') && renders !== undefined);
          expect(inlineUiOffered(input), JSON.stringify(input)).toBe(expected);
        }
      }
    }
  });
});

describe('inlineUiPrompt', () => {
  it('opens with when to use one, in positive terms, before the format', () => {
    const prompt = inlineUiPrompt('auto');
    const use = prompt.indexOf('Use one when');
    expect(use).toBeGreaterThan(0);
    expect(use).toBeLessThan(prompt.indexOf('Components ('));
    for (const cue of ['choose, confirm or give several values', 'sortable Table', 'a Chart', 'inputs and computed values', 'Steps']) expect(prompt).toContain(cue);
    expect(prompt).not.toMatch(/only when|at most one/i);
  });

  it('teaches the view format, the round trip, the HTML fallback, markers and the source tool', () => {
    const prompt = inlineUiPrompt('auto');
    expect(prompt).toContain('```octi-ui title=');
    expect(prompt).toContain('"data", "computed"');
    expect(prompt).toContain('A Button event sends you the user\'s answer');
    expect(prompt).toContain('a custom diagram, an animation, a game');
    expect(prompt).toContain('addEventListener');
    expect(prompt).toContain('octi.prompt(text)');
    expect(prompt).toContain('inline-ui__source');
    expect(prompt).toContain('never in a message that also calls tools');
  });

  it('carries the catalog verbatim', async () => {
    const { inlineUiViewCatalogPrompt } = await import('@/shared/inline-ui');
    expect(inlineUiPrompt('auto')).toContain(inlineUiViewCatalogPrompt());
  });

  it('every example is a view that lints without any issue', () => {
    const fences = findInlineUiFences(inlineUiPrompt('auto'));
    expect(fences).toHaveLength(INLINE_UI_PROMPT_EXAMPLES.length);
    for (const fence of fences) {
      expect(isInlineUiViewBody(fence.body), fence.title).toBe(true);
      const { view, issues } = lintInlineUiView(fence.body, { closed: fence.closed });
      expect(issues, fence.title).toEqual([]);
      expect(view, fence.title).toBeDefined();
    }
    // One answers the agent (a primary Button with an event), one computes from an input.
    expect(INLINE_UI_PROMPT_EXAMPLES[0].body).toMatch(/"ChoicePicker".*"variant":"primary".*"event"/s);
    expect(INLINE_UI_PROMPT_EXAMPLES[1].body).toMatch(/"computed".*"Slider".*"Stat"/s);
  });

  it('prefer adds one line; auto does not', () => {
    const auto = inlineUiPrompt('auto').split('\n');
    const prefer = inlineUiPrompt('prefer').split('\n');
    expect(prefer.length).toBe(auto.length + 1);
    expect(prefer.filter((l) => !auto.includes(l))).toEqual(['Prefer one whenever the answer has any structure.']);
  });

  it('the artifacts line goes with its module, and nothing else does', () => {
    const prompt = inlineUiPrompt('auto');
    const off = withoutOffModules(prompt, (id) => id !== 'artifacts', () => true);
    expect(off).not.toContain('live artifact');
    expect(off.split('\n').length).toBe(prompt.split('\n').length - 1);
    expect(off).toContain('stay text.');
  });

  it('stays within its budget: 1 000 tokens, 3 800 characters as the model reads it', () => {
    for (const setting of INTERACTIVE_ANSWER_SETTINGS) {
      const seen = withoutOffModules(inlineUiPrompt(setting), () => true, () => true);
      expect(seen.length, setting).toBeLessThanOrEqual(3_800);
      expect(estimateTokens(seen), setting).toBeLessThanOrEqual(1_000);
    }
  });
});
