/**
 * Routing by protection level (docs/PROTECTION-LEVELS.md, C6b).
 *
 * What must hold: a session's level only ever rises, and unclear content
 * counts as 4; while the `protection` module is on, a session at 3-4 runs on
 * local models only — switched to one where there is one, refused where there
 * is none; a CLI agent and a fallback to the LiteLLM proxy never count as
 * local; with the module off, nothing is routed.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ModelConfigEntry } from '@/db/schema/models';

let protectionOn = true;
vi.mock('@/core/modules/registry', () => ({ isModuleOn: (id: string) => id === 'protection' && protectionOn }));
vi.mock('@/config', () => ({ getConfig: () => ({ ollama: { url: 'http://localhost:11434' } }) }));
vi.mock('@/models/local-decision', () => ({ ollamaRunsLocally: async (_endpoint: string, model: string) => !model.endsWith('-cloud') }));

const { assertMayLeave, localOnlyLevel, localRowInstead, ProtectionRoutingError, runsLocally } = await import('./routing');
const { highestLevel, raiseSessionLevel, resetSessionLevels, sessionProtectionLevel, withContentLevel } = await import('./session-level');

function row(name: string, over: Partial<ModelConfigEntry> = {}): ModelConfigEntry {
  return {
    name, provider: 'openai', modelId: name, endpoint: null, metadata: {}, isEnabled: true, supportsTools: true, supportsVision: false,
    ...over,
  } as ModelConfigEntry;
}

const remote = row('gpt-remote');
const localOllama = row('llama-local', { provider: 'ollama', endpoint: 'http://192.168.1.20:11434' });
const cloudOllama = row('gpt-oss-cloud', { provider: 'ollama', endpoint: 'http://localhost:11434' });
const localCustom = row('vllm-local', { provider: 'custom-openai', endpoint: 'http://vllm:8000', metadata: { dataPolicy: { hosting: 'local', retention: 'none', trainsOnInput: false } } });

// Synthetic (non-UUID) ids: nothing is written to a database.
let n = 0;
const session = () => `test-session-${++n}`;

beforeEach(() => {
  protectionOn = true;
  resetSessionLevels();
});

describe('the session level', () => {
  test('rises to the highest level read, and never goes down', () => {
    const s = session();
    expect(sessionProtectionLevel(s)).toBe(1);
    raiseSessionLevel(s, 2);
    raiseSessionLevel(s, 3);
    raiseSessionLevel(s, 1);
    expect(sessionProtectionLevel(s)).toBe(3);
  });

  test('unclear content counts as 4', () => {
    const s = session();
    raiseSessionLevel(s, null);
    expect(sessionProtectionLevel(s)).toBe(4);
    expect(highestLevel([1, null])).toBe(4);
    expect(highestLevel([])).toBeUndefined();
  });

  test('each session has its own', () => {
    const a = session();
    const b = session();
    raiseSessionLevel(a, 4);
    expect(sessionProtectionLevel(b)).toBe(1);
  });
});

describe('when calls must stay local', () => {
  test('from level 3, while the module is on', async () => {
    const s = session();
    raiseSessionLevel(s, 2);
    expect(await localOnlyLevel(s)).toBeUndefined();
    raiseSessionLevel(s, 3);
    expect(await localOnlyLevel(s)).toBe(3);
    protectionOn = false;
    expect(await localOnlyLevel(s)).toBeUndefined();
  });

  test('document work follows the document level, outside any session', async () => {
    expect(await withContentLevel(4, () => localOnlyLevel(undefined))).toBe(4);
    expect(await withContentLevel(null, () => localOnlyLevel(undefined))).toBe(4);
    expect(await withContentLevel(2, () => localOnlyLevel(undefined))).toBeUndefined();
  });
});

describe('what counts as local', () => {
  test('Ollama on a private endpoint, a row whose data policy says so; not a cloud model, a CLI agent or a hosted API', async () => {
    expect(await runsLocally(localOllama)).toBe(true);
    expect(await runsLocally(localCustom)).toBe(true);
    expect(await runsLocally(cloudOllama)).toBe(false);
    expect(await runsLocally(remote)).toBe(false);
    expect(await runsLocally(row('claude-cli', { provider: 'cli' }))).toBe(false);
    expect(await runsLocally(null)).toBe(false);
  });

  test('a fallback to the LiteLLM proxy leaves the local row', async () => {
    expect(await runsLocally(localOllama, 'ollama')).toBe(true);
    expect(await runsLocally(localOllama, 'litellm')).toBe(false);
  });
});

describe('a call that would leave the house', () => {
  test('is refused at level 3-4, with the reason', async () => {
    const s = session();
    raiseSessionLevel(s, 4);
    await expect(assertMayLeave(remote, s)).rejects.toBeInstanceOf(ProtectionRoutingError);
    await expect(assertMayLeave(remote, s)).rejects.toThrow(/protection level 4.*stays on local models/);
    await expect(assertMayLeave(localOllama, s, 'ollama')).resolves.toBeUndefined();
    await expect(assertMayLeave(localOllama, s, 'litellm')).rejects.toBeInstanceOf(ProtectionRoutingError);
  });

  test('goes ahead below 3, and with the module off', async () => {
    const s = session();
    raiseSessionLevel(s, 2);
    await expect(assertMayLeave(remote, s)).resolves.toBeUndefined();
    raiseSessionLevel(s, 4);
    protectionOn = false;
    await expect(assertMayLeave(remote, s)).resolves.toBeUndefined();
  });
});

describe('choosing the model', () => {
  const candidates = (rows: ModelConfigEntry[], defaultModel: ModelConfigEntry | null = null) => async () => ({ defaultModel, rows });

  test('a confidential session is switched to a local model', async () => {
    const s = session();
    raiseSessionLevel(s, 3);
    expect(await localRowInstead(remote, s, 'tools', candidates([remote, cloudOllama, localOllama]))).toBe(localOllama);
    // A local default comes first.
    expect(await localRowInstead(remote, s, 'tools', candidates([localOllama, localCustom], localCustom))).toBe(localCustom);
  });

  test('a local model stays; so does any model below 3', async () => {
    const s = session();
    raiseSessionLevel(s, 4);
    expect(await localRowInstead(localOllama, s, 'tools', candidates([]))).toBe(localOllama);
    const low = session();
    raiseSessionLevel(low, 2);
    expect(await localRowInstead(remote, low, 'tools', candidates([]))).toBe(remote);
  });

  test('the replacement does what is needed: tools, or reading images', async () => {
    const s = session();
    raiseSessionLevel(s, 4);
    const noTools = row('embed-local', { provider: 'ollama', endpoint: 'http://localhost:11434', supportsTools: false });
    const seesImages = row('llava-local', { provider: 'ollama', endpoint: 'http://localhost:11434', supportsVision: true });
    expect(await localRowInstead(remote, s, 'tools', candidates([noTools, localOllama]))).toBe(localOllama);
    expect(await localRowInstead(remote, s, 'vision', candidates([localOllama, seesImages]))).toBe(seesImages);
    const disabled = row('off-local', { provider: 'ollama', endpoint: 'http://localhost:11434', isEnabled: false });
    await expect(localRowInstead(remote, s, 'tools', candidates([disabled]))).rejects.toBeInstanceOf(ProtectionRoutingError);
  });

  test('with no local model bound, the turn stops and says so', async () => {
    const s = session();
    raiseSessionLevel(s, 3);
    await expect(localRowInstead(remote, s, 'tools', candidates([remote, cloudOllama]))).rejects.toThrow(/no local model is bound/);
  });
});
