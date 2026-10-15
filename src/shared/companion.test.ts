import { describe, expect, test } from 'vitest';
import { mentionsCompanion, withoutCompanionMentions } from './companion';

describe('personal companion mentions', () => {
  test.each([
    ['@Sparkle help', 'Sparkle'], ['Hello, @sparkle!', 'Sparkle'],
    ['@小墨 help', '小墨'], ['@Little Ink, ready?', 'Little Ink'],
    ['@Ink+ help', 'Ink+'], ['(@🐙)', '🐙'],
  ])('matches the literal name in %s', (text, name) => {
    expect(mentionsCompanion(text, name)).toBe(true);
  });
  test.each(['me@Sparkle', '@Sparkles', '@Sparkle-bot', '@Sparkle@abcdefgh', '@Sparkle猫'])('does not address a prefix or handle: %s', (text) => {
    expect(mentionsCompanion(text, 'Sparkle')).toBe(false);
  });
  test('removes only companion mentions before member notifications', () => {
    expect(withoutCompanionMentions('@Little Ink ask @ben and @Little Ink!', 'Little Ink')).toBe(' ask @ben and !');
    expect(mentionsCompanion('hello @', '')).toBe(false);
  });
});
