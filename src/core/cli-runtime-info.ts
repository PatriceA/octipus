import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import type { CliModelOption } from '@/shared/cli-capabilities';
import { coreLogger } from '@/utils/logger';

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    coreLogger.warn({ code: (error as NodeJS.ErrnoException).code }, 'CLI model metadata cannot be read');
    return null;
  }
}
/** Read non-secret Codex model metadata from the same credential-scoped home as the launch. */
export async function codexRuntimeInfo(
  env: Record<string, string | undefined>,
  cwd?: string,
): Promise<{ model?: string; effort?: string; contextWindow?: number; models: CliModelOption[] }> {
  const home = env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.codex');
  let config: Record<string, unknown> = {};
  for (const path of [join(home, 'config.toml'), ...(cwd ? [join(cwd, '.codex', 'config.toml')] : [])]) {
    const source = await readOptional(path);
    if (!source) continue;
    try {
      config = { ...config, ...parse(source) };
    } catch {
      coreLogger.warn('CLI model metadata has invalid TOML; effective model will require runtime evidence');
    }
  }
  const profile =
    typeof config.profile === 'string' && config.profiles && typeof config.profiles === 'object'
      ? (config.profiles as Record<string, Record<string, unknown>>)[config.profile]
      : undefined;
  config = { ...config, ...profile };
  const model = typeof config.model === 'string' ? config.model : undefined;
  const effort = typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : undefined;
  const contextWindow =
    typeof config.model_context_window === 'number' && config.model_context_window > 0
      ? config.model_context_window
      : undefined;
  const source = await readOptional(join(home, 'models_cache.json'));
  let models: CliModelOption[] = [];
  if (source) {
    try {
      const cache = JSON.parse(source) as { models?: Array<{ slug?: unknown; display_name?: unknown }> };
      if (Array.isArray(cache.models))
        models = cache.models.flatMap((m) =>
          typeof m.slug === 'string'
            ? [{ id: m.slug, label: typeof m.display_name === 'string' ? m.display_name : m.slug }]
            : [],
        );
    } catch {
      coreLogger.warn('CLI model catalog cache is invalid JSON');
    }
  }
  return { model, effort, contextWindow, models };
}

/** Extract only current model/effort and last-request usage from the linked Codex rollout. */
export function codexContextFromLog(
  tail: string,
): {
  model?: string;
  effort?: string;
  usedTokens?: number;
  contextWindow?: number;
  at?: string;
  source: string;
} | null {
  const result: {
    model?: string;
    effort?: string;
    usedTokens?: number;
    contextWindow?: number;
    at?: string;
    source: string;
  } = { source: 'CLI session log' };
  let recognized = false;
  for (const line of tail.split('\n')) {
    let row: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    } // A bounded tail may begin/end inside a record.
    if (!row || typeof row !== 'object') continue;
    const p = row.payload;
    if (!p) continue;
    if (row.type === 'turn_context') {
      if (typeof p.model === 'string') {
        result.model = p.model;
        recognized = true;
      }
      if (typeof p.effort === 'string') result.effort = p.effort;
    }
    if (row.type === 'event_msg' && p.type === 'token_count') {
      const info = p.info as
        | { last_token_usage?: { input_tokens?: unknown; output_tokens?: unknown }; model_context_window?: unknown }
        | undefined;
      const input = info?.last_token_usage?.input_tokens;
      const output = info?.last_token_usage?.output_tokens;
      if (typeof input === 'number' && Number.isFinite(input) && input >= 0) {
        result.usedTokens = input + (typeof output === 'number' && Number.isFinite(output) && output > 0 ? output : 0);
        recognized = true;
        result.at = row.timestamp;
      }
      const window = info?.model_context_window;
      if (typeof window === 'number' && Number.isFinite(window) && window > 0) result.contextWindow = window;
    }
  }
  return recognized ? result : null;
}

/** Bounded, read-only telemetry from the exact thread, under its credential home. Never a CLI prompt. */
export function codexContextReader(
  id: string,
  env: Record<string, string | undefined>,
): () => Promise<ReturnType<typeof codexContextFromLog>> {
  let path: string | undefined;
  let misses = 0;
  return async () => {
    if (!/^[a-f0-9-]{36}$/i.test(id) || misses > 3) return null;
    const { glob, open } = await import('node:fs/promises');
    if (!path) {
      const home = env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.codex');
      try {
        for await (const found of glob(`sessions/*/*/*/*${id}.jsonl`, { cwd: home })) {
          path = join(home, found);
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          coreLogger.warn({ code: (error as NodeJS.ErrnoException).code }, 'CLI session log location unavailable');
      }
      if (!path) {
        misses++;
        return null;
      }
    }
    let file;
    try {
      file = await open(path, 'r');
      const size = (await file.stat()).size;
      const bytes = Buffer.alloc(Math.min(size, 256 * 1024));
      const read = await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      return codexContextFromLog(bytes.subarray(0, read.bytesRead).toString('utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        coreLogger.warn({ code: (error as NodeJS.ErrnoException).code }, 'CLI session context cannot be read');
      return null;
    } finally {
      await file?.close();
    }
  };
}
