import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { codexRuntimeInfo } from './cli-runtime-info';
test('Codex model metadata uses only the supplied credential home and does not expose secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-info-'));
  try {
    await writeFile(
      join(dir, 'config.toml'),
      'model="base-model"\nprofile="work"\nsecret="hidden"\n[profiles.work]\nmodel="profile-model"\nmodel_reasoning_effort="high"\n',
    );
    await writeFile(
      join(dir, 'models_cache.json'),
      JSON.stringify({
        models: [{ slug: 'account-model', display_name: 'Account model' }, { slug: 7 }],
        token: 'hidden',
      }),
    );
    expect(await codexRuntimeInfo({ CODEX_HOME: dir })).toEqual({
      model: 'profile-model',
      effort: 'high',
      contextWindow: undefined,
      models: [{ id: 'account-model', label: 'Account model' }],
    });
    expect(await codexRuntimeInfo({ CODEX_HOME: join(dir, 'absent') })).toEqual({
      model: undefined,
      effort: undefined,
      contextWindow: undefined,
      models: [],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Codex rollout reads latest-request context and never aggregate billing or response text', async () => {
  const { codexContextFromLog } = await import('./cli-runtime-info');
  const log = [
    'partial record',
    JSON.stringify({
      type: 'turn_context',
      payload: { model: 'actual', effort: 'high', developer_instructions: 'hidden' },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-11-19T10:00:00Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 9000000 },
          last_token_usage: { input_tokens: 12000, output_tokens: 100 },
          model_context_window: 200000,
        },
      },
    }),
    JSON.stringify({ type: 'response_item', payload: { content: 'hidden' } }),
  ].join('\n');
  expect(codexContextFromLog(log)).toEqual({
    source: 'CLI session log',
    model: 'actual',
    effort: 'high',
    usedTokens: 12100,
    contextWindow: 200000,
    at: '2026-11-19T10:00:00Z',
  });
  expect(codexContextFromLog('{"type":"response_item"}')).toBeNull();
});
