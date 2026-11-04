import { posix } from 'node:path';
import { tokenizeSafe } from '@/tools/shell/policy';
import type { SpaceToolCall } from './space-tools';

/** An approved metadata check names its host, workspace and individual files. */
export interface SshFileMetadataScope {
  target: string;
  cwd: string;
  paths: string[];
}

function fixedPath(value: unknown): value is string {
  return typeof value === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(value) && value === posix.normalize(value);
}

/** Only stat's literal name/size/mode/type output; no contents, globbing or shell effects. */
export function matchesSshFileMetadata(scope: SshFileMetadataScope, call: SpaceToolCall): boolean {
  if (!scope || typeof scope.target !== 'string' || !fixedPath(scope.cwd) || !Array.isArray(scope.paths)
    || !scope.paths.length || scope.paths.length > 20 || !scope.paths.every(fixedPath)) return false;
  if (call.toolId !== 'shell' || call.toolName !== 'run' || call.action !== 'execute') return false;
  const args = call.args ?? {};
  if (args.cwd !== scope.cwd || args.useShell === true || typeof args.command !== 'string'
    || Object.keys(args).some(key => !['command', 'cwd', 'network', 'useShell', 'timeout'].includes(key))) return false;
  const command = args.command;
  if (/[\\;&|<>$`\u0000-\u001f\u007f]/.test(command)) return false;
  const words = tokenizeSafe(command);
  if (!words || words[0] !== 'ssh') return false;
  let i = 1;
  while (words[i] === '-o') {
    if (words[i + 1] !== 'BatchMode=yes' && !/^ConnectTimeout=[1-9][0-9]?$/.test(words[i + 1] ?? '')) return false;
    i += 2;
  }
  if (words[i++] !== scope.target || words.length !== i + 1) return false;
  const remote = tokenizeSafe(words[i]);
  if (!remote || remote[0] !== 'stat') return false;
  let format: string | undefined;
  let paths: string[];
  if (remote[1]?.startsWith('--format=')) { format = remote[1].slice('--format='.length); paths = remote.slice(2); }
  else if (['-c', '--format'].includes(remote[1])) { format = remote[2]; paths = remote.slice(3); }
  else return false;
  if (!format || !/^(?:%[nsaF]|[: ,_-])+$/.test(format)) return false;
  return paths.length > 0 && paths.length <= 20 && paths.every(path => fixedPath(path) && scope.paths.includes(path));
}
