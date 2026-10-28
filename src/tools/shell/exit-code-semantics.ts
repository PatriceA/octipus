import { shellCommandSegments } from './command-positions';

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
  'grep': { 1: 'no_match', 2: 'error' },
  'diff': { 1: 'has_changes' },
  'diff-index': { 1: 'has_changes' },
  'diff-tree': { 1: 'has_changes' },
};

function headCommand(cmd: string): { bin: string; arg1?: string; flags: string[] } {
  const segments = shellCommandSegments(cmd);
  if (!segments || segments.length !== 1) return { bin: '', flags: [] };
  const parts = segments[0];
  const bin = (parts[0] ?? '').replace(/.*[/\\]/, '');
  let rest = parts.slice(1);
  if (bin === 'git') {
    const valueFlags = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
    while (rest.length && rest[0].startsWith('-')) {
      const option = rest[0];
      rest = rest.slice(valueFlags.has(option) ? 2 : 1);
      if (option === '--') break;
    }
  }
  const arg1 = rest.find(p => !p.startsWith('-'));
  const flags = rest.filter(p => p.startsWith('-'));
  return { bin, arg1, flags };
}

export function interpretExit(command: string, exitCode: number, stderr = ''): ExitInterpretation {
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
      const semantic = map[exitCode];
      return semantic === 'error' || semantic === 'no_match' && !!stderr.trim()
        ? { outcome: 'error', semantic: 'error' } : { outcome: 'expected_nonzero', semantic };
    }
    return { outcome: 'error' };
  }

  const map = SIMPLE[bin];
  if (map && map[exitCode]) {
    const semantic = map[exitCode];
    return semantic === 'error' || semantic === 'no_match' && !!stderr.trim()
        ? { outcome: 'error', semantic: 'error' } : { outcome: 'expected_nonzero', semantic };
  }

  return { outcome: 'error' };
}
