/**
 * `setLocalStatementTimeout`: on Postgres a statement is cancelled at the
 * timeout (`SET LOCAL statement_timeout`, for the transaction only); PGlite
 * runs a statement to its end whatever the setting says, so nothing is sent
 * there and the caller bounds the work itself.
 */
import { describe, expect, test, vi } from 'vitest';

const mode = vi.hoisted(() => ({ value: 'external' as 'external' | 'embedded' }));
vi.mock('@/db/postgres', async (original) => ({ ...await original<object>(), storageMode: () => mode.value }));
const { setLocalStatementTimeout } = await import('./vector-indexes');

function fakeTx() {
  const sent: string[] = [];
  const tx = { execute: async (q: { queryChunks?: Array<{ value?: string[] }> }) => { sent.push((q.queryChunks ?? []).flatMap((c) => c.value ?? []).join('')); return []; } };
  return { tx: tx as unknown as Parameters<typeof setLocalStatementTimeout>[0], sent };
}

describe('setLocalStatementTimeout', () => {
  test('on Postgres: SET LOCAL statement_timeout, rounded up to a whole millisecond', async () => {
    mode.value = 'external';
    const { tx, sent } = fakeTx();
    await setLocalStatementTimeout(tx, 2999.2);
    expect(sent).toEqual(['SET LOCAL statement_timeout = 3000']);
  });

  test('on PGlite, or without a timeout: nothing is sent', async () => {
    mode.value = 'embedded';
    const embedded = fakeTx();
    await setLocalStatementTimeout(embedded.tx, 3000);
    expect(embedded.sent).toEqual([]);
    mode.value = 'external';
    const none = fakeTx();
    await setLocalStatementTimeout(none.tx, undefined);
    expect(none.sent).toEqual([]);
  });
});
