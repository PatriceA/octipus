import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { configuredCliBinary } from './cli-executable';
import { buildChildEnv } from './cli-child-env';
import { prepareAgyRuntime } from './agy-cli-runtime';
import type { CliModelOption } from '@/shared/cli-capabilities';

/** CLI model catalogs require no inference or separately configured Google API key. */
export function parseAgyModels(stdout: string): CliModelOption[] {
  const models = stdout.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const [id, ...label] = line.split('\t');
    if (!id?.trim() || !label.join(' ').trim()) throw new Error('Antigravity returned an invalid model catalog');
    return { id: id.trim(), label: label.join(' ').trim() };
  });
  if (!models.length) throw new Error('Antigravity returned an empty model catalog');
  return models;
}

let cached: { expires: number; value?: CliModelOption[]; error?: Error } | undefined;
let pending: Promise<CliModelOption[]> | undefined;
export function resetAgyModelCatalog(): void { cached = undefined; pending = undefined; }

/** Coalesce status polling and cache failures briefly so login issues do not spawn repeatedly. */
export async function discoverAgyModels(): Promise<CliModelOption[]> {
  if (cached && Date.now() < cached.expires) {
    if (cached.error) throw cached.error;
    return cached.value ?? [];
  }
  if (pending) return pending;
  pending = (async () => {
    let run: ReturnType<typeof prepareAgyRuntime> | undefined;
    try {
      run = prepareAgyRuntime({ workspace: 'octipus-model-catalog', instructions: '' });
      const prepared = run;
      const output = await new Promise<string>((resolve, reject) => {
        execFile(configuredCliBinary('agy'), ['--settings', prepared.settingsPath, 'models'], { cwd: prepared.cwd,
          env: buildChildEnv({ modelProvider: 'google' }, prepared.env), encoding: 'utf8', timeout: 20_000,
          maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      const value = parseAgyModels(output);
      cached = { expires: Date.now() + 300_000, value };
      return value;
    } catch {
      const error = new Error('Antigravity model catalog unavailable. Check that agy models works as the Octipus OS account, then retry after 30 seconds.');
      cached = { expires: Date.now() + 30_000, error };
      throw error;
    } finally { for (const path of run?.cleanupPaths ?? []) rmSync(path, { recursive: true, force: true }); }
  })();
  try { return await pending; } finally { pending = undefined; }
}
