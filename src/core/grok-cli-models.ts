import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import type { CliModelOption } from '@/shared/cli-capabilities';
import { buildChildEnv } from './cli-child-env';
import { configuredCliBinary } from './cli-executable';
import { prepareGrokRuntime } from './grok-cli-runtime';

/** Read only the account's available-model section, not its default or login banner. */
export function parseGrokModels(stdout: string): CliModelOption[] {
  const lines = stripVTControlCharacters(stdout).split(/\r?\n/);
  const heading = lines.findIndex(line => line.trim() === 'Available models:');
  if (heading < 0) throw new Error('Grok Build returned an invalid model catalog');
  const models: CliModelOption[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s+(?:[*-]\s+)?([\w][\w.:/-]*)(\s+\(default\))?\s*$/);
    if (!match) throw new Error('Grok Build returned an invalid model catalog');
    const id = match[1];
    if (!models.some(model => model.id === id)) models.push({ id, label: id + (match[2] ? ' (default)' : '') });
  }
  if (!models.length) throw new Error('Grok Build returned an empty model catalog');
  return models;
}

let cached: { expires: number; value?: CliModelOption[]; error?: Error } | undefined;
let pending: Promise<CliModelOption[]> | undefined;
export function resetGrokModelCatalog(): void { cached = undefined; pending = undefined; }

/** No inference, API model list or API key: use the existing CLI account login. */
export async function discoverGrokModels(): Promise<CliModelOption[]> {
  if (cached && Date.now() < cached.expires) {
    if (cached.error) throw cached.error;
    return cached.value ?? [];
  }
  if (pending) return pending;
  pending = (async () => {
    let run: ReturnType<typeof prepareGrokRuntime> | undefined;
    try {
      run = prepareGrokRuntime({ prompt: '', workspace: 'octipus-model-catalog', maxTurns: 1 });
      const prepared = run;
      const output = await new Promise<string>((resolve, reject) => {
        execFile(configuredCliBinary('grok'), ['--no-leader', 'models'], { cwd: prepared.cwd,
          env: buildChildEnv({ modelProvider: 'grok' }, prepared.env), encoding: 'utf8', timeout: 20_000,
          maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      const value = parseGrokModels(output);
      cached = { expires: Date.now() + 300_000, value };
      return value;
    } catch {
      const error = new Error('Grok Build model catalog unavailable. Run grok login and grok models as the Octipus OS account, then retry after 30 seconds.');
      cached = { expires: Date.now() + 30_000, error };
      throw error;
    } finally { for (const path of run?.cleanupPaths ?? []) rmSync(path, { recursive: true, force: true }); }
  })();
  try { return await pending; } finally { pending = undefined; }
}
