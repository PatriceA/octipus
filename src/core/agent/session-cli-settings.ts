import type { CLIAgentConfig } from '@/db/schema/models';
import {
  cliEfforts,
  sessionCliOverride,
  validCliModel,
  type SessionCliOverride,
} from '@/shared/session-model-controls';

/** Pure overlay. Does not mutate the registered model or allow permission/credential overrides. */
export function applySessionCliSettings(
  base: CLIAgentConfig,
  entries: readonly SessionCliOverride[],
  scope: { modelName: string; topic: string; role: string; adapter: string },
): CLIAgentConfig {
  const selected = sessionCliOverride(entries, scope.modelName, scope.topic, scope.role);
  if (!selected) return { ...base };
  if (selected.model && !validCliModel(selected.model)) throw new Error('Invalid session CLI model identifier');
  if (selected.effort && !cliEfforts(scope.adapter).includes(selected.effort))
    throw new Error(`Reasoning effort is not supported by ${scope.adapter}`);
  const flag = scope.adapter === 'Muse Code' ? '--reasoning-effort' : '--effort';
  // Replace an old typed effort flag rather than sending conflicting controls.
  const extraArgs: string[] = [];
  const source = base.extraArgs ?? [];
  for (let i = 0; i < source.length; i++) {
    if (selected.effort && source[i] === flag) {
      i++;
      continue;
    }
    if (selected.effort && source[i].startsWith(`${flag}=`)) continue;
    extraArgs.push(source[i]);
  }
  return {
    ...base,
    extraArgs,
    ...(selected.model ? { model: selected.model, sessionModelOverride: true } : {}),
    ...(selected.effort ? { effort: selected.effort } : {}),
  };
}

/** Effective typed/additive effort, for display without changing the launch arguments. */
export function configuredCliEffort(settings: CLIAgentConfig, adapter: string): string | undefined {
  if (settings.effort) return settings.effort;
  const flag = adapter === 'Muse Code' ? '--reasoning-effort' : '--effort';
  const args = settings.extraArgs ?? [];
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) found = args[++i];
    else if (args[i].startsWith(`${flag}=`)) found = args[i].slice(flag.length + 1);
  }
  return found;
}
