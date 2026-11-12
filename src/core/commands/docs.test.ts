import { afterEach, expect, test, vi } from 'vitest';
import { productDocs } from '@/core/product-docs';
import './docs';
import { getCommand } from './registry';
afterEach(() => vi.restoreAllMocks());
const ctx = (args: string) => ({ args, userId: 'user', sessionId: 'session' });
test('empty /docs explains usage without loading the manual', async () => {
  const search = vi.spyOn(productDocs, 'search');
  expect((await getCommand('docs')!.execute(ctx(' '))).response).toContain('Usage');
  expect(search).not.toHaveBeenCalled();
});
test('/docs formats local sources and line numbers without a knowledge service', async () => {
  const search = vi.spyOn(productDocs, 'search').mockResolvedValue([{ file: 'CHANNELS.md', title: 'Channels', heading: 'Telegram', line: 42, excerpt: 'Create a bot with BotFather.' }]);
  const result = await getCommand('docs')!.execute(ctx('Telegram setup'));
  expect(search).toHaveBeenCalledWith('Telegram setup', 8);
  expect(result.response).toContain('docs/CHANNELS.md:42');
  expect(result.response).toContain('BotFather');
});
test('no match suggests keywords rather than waiting for embedding', async () => {
  vi.spyOn(productDocs, 'search').mockResolvedValue([]);
  expect((await getCommand('docs')!.execute(ctx('unknown'))).response).toContain('specific feature or setting names');
});
test('missing docs explains the install prerequisite', async () => {
  vi.spyOn(productDocs, 'search').mockRejectedValue(new Error('missing'));
  expect((await getCommand('docs')!.execute(ctx('setup'))).response).toContain('no embedding model is needed');
});
