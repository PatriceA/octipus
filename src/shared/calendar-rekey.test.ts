import { expect, test } from 'vitest';
import { rekeyCalendarVisibility } from './calendar';

test('visible-calendar keys follow a default change, and back', () => {
  const before = ['google:me@one.x', 'google:team@group.calendar.google.com', 'google:me@two.x:me@two.x', 'google:me@three.x:c1', 'microsoft:AAMk1'];
  const after = rekeyCalendarVisibility(before, 'google', 'me@one.x', 'me@two.x');
  expect(after).toEqual(['google:me@one.x:me@one.x', 'google:me@one.x:team@group.calendar.google.com', 'google:me@two.x', 'google:me@three.x:c1', 'microsoft:AAMk1']);
  expect(rekeyCalendarVisibility(after, 'google', 'me@two.x', 'me@one.x')).toEqual(before);
  // The old default's address unknown: its bare keys are dropped, never read as the new default's.
  expect(rekeyCalendarVisibility(['google:old-cal', 'google:me@two.x:c2'], 'google', undefined, 'ME@two.x')).toEqual(['google:c2']);
});
