import { expect, test } from 'vitest';
import { withoutDuplicates } from './index';

test('add_items does not append an item already on the plan or twice in one batch (#23)', () => {
  const existing = [{ title: 'Member time_entries RLS performance' }];
  const batch = [{ title: 'member  time_entries RLS performance' }, { title: 'New item' }, { title: 'new item' }];
  expect(withoutDuplicates(existing, batch)).toEqual([{ title: 'New item' }]);
});
