import type { CliModelOption } from './cli-capabilities';

/** A CLI setting scoped to a topic and optionally one agent role in this session. */
export interface SessionCliOverride {
  modelName: string;
  topic: string;
  role?: string;
  model?: string;
  effort?: string;
}
export interface SessionCliBinding {
  modelName: string;
  topic: string;
  adapter: string;
  model: string | null;
  effort: string | null;
  efforts: readonly string[];
  modelSelectable?: boolean;
  models: CliModelOption[];
  catalogError?: string;
}
export interface SessionModelControls {
  editable?: boolean;
  revision: number;
  overrides: SessionCliOverride[];
  bindings: SessionCliBinding[];
  runs: Array<{
    id: string;
    role: string;
    topic: string;
    root: boolean;
    status: string;
    adapter: string;
    model: string | null;
    effort?: string;
    at: string;
  }>;
}

/** Validate a model identifier before it reaches CLI flags, TOML or environment. */
export function validCliModel(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(value);
}
export function cliEfforts(adapter: string): readonly string[] {
  if (adapter === 'Codex CLI') return ['minimal', 'low', 'medium', 'high', 'xhigh'];
  if (adapter === 'Claude Code' || adapter === 'Antigravity') return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (adapter === 'Muse Code') return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  return [];
}
export function sessionCliOverride(
  entries: readonly SessionCliOverride[],
  modelName: string,
  topic: string,
  role: string,
): SessionCliOverride | undefined {
  const topicDefault = entries.find((e) => e.modelName === modelName && e.topic === topic && !e.role);
  const agent = entries.find((e) => e.modelName === modelName && e.topic === topic && e.role === role);
  return agent ? { ...topicDefault, ...agent } : topicDefault;
}
