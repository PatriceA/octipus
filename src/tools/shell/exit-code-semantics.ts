/**
 * Contextualize shell exit codes. Many tools exit non-zero for normal
 * conditions (grep=1 "no matches", diff=1 "files differ", test=1 "false").
 * Mapping these to semantic labels stops the agent from reporting false errors
 * and retrying commands that actually worked.
 */

export type ExitOutcome = 'ok' | 'expected_nonzero' | 'error';

export interface ExitInterpretation {
  outcome: ExitOutcome;
  semantic?: string;
}

type CodeMap = Record<number, string>;

const SIMPLE: Record<string, CodeMap> = {
  grep: { 1: 'no_match', 2: 'error' },
  egrep: { 1: 'no_match', 2: 'error' },
  fgrep: { 1: 'no_match', 2: 'error' },
  rg: { 1: 'no_match', 2: 'error' },
  diff: { 1: 'files_differ', 2: 'error' },
  cmp: { 1: 'files_differ', 2: 'error' },
  test: { 1: 'false' },
  '[': { 1: 'false' },
};

const GIT_SUBCOMMAND: Record<string, CodeMap> = {
  'diff': { 1: 'has_changes' },
  'diff-index': { 1: 'has_changes' },
  'diff-tree': { 1: 'has_changes' },
};

function headCommand(cmd: string): { bin: string; arg1?: string; flags: string[] } {
  const trimmed = cmd.trim();
  if (!trimmed) return { bin: '', flags: [] };
  const firstSegment = trimmed.split(/[|;&]/)[0]!.trim();
  const parts = firstSegment.split(/\s+/);
  const bin = (parts[0] ?? '').replace(/.*\//, '');
  const rest = parts.slice(1);
  const arg1 = rest.find(p => !p.startsWith('-'));
  const flags = rest.filter(p => p.startsWith('-'));
  return { bin, arg1, flags };
}

export function interpretExit(command: string, exitCode: number): ExitInterpretation {
  if (exitCode === 0) return { outcome: 'ok' };

  const { bin, arg1, flags } = headCommand(command);
  if (!bin) return { outcome: 'error' };

  if (bin === 'git') {
    const sub = arg1 ?? '';
    const map = GIT_SUBCOMMAND[sub];
    if (map && map[exitCode]) {
      // `git diff --exit-code` semantically returns 1 for "has changes".
      if (sub === 'diff' && !flags.includes('--exit-code') && exitCode === 1) {
        return { outcome: 'error' };
      }
      return { outcome: 'expected_nonzero', semantic: map[exitCode] };
    }
    return { outcome: 'error' };
  }

  const map = SIMPLE[bin];
  if (map && map[exitCode]) {
    return { outcome: 'expected_nonzero', semantic: map[exitCode] };
  }

  return { outcome: 'error' };
}
