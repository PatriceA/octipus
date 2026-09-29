import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Pre-tool-use guard for managed CLI agents: blocks shell commands that talk
 * to the network (curl, Invoke-RestMethod, python/node fetch one-liners, a
 * local MCP endpoint) so agents reach services through Octipus's registered
 * tools instead of a hand-rolled client. The prompt alone was ignored in
 * practice. `# octipus-fallback: <reason>` in the command lets it through.
 *
 * One matcher, one hook script, per-vendor wiring in cli-adapters:
 * Claude `--settings`, Codex `-c hooks.PreToolUse`, Antigravity `--add-dir`
 * with `.agents/hooks.json`. Mistral Vibe has no hook mechanism; prompt only.
 */

/** Tool names the Claude/Codex hook matches; agy's shell tool is `run_command`. */
export const SHELL_GUARD_TOOL_MATCHER = 'Bash|PowerShell';

export const SHELL_GUARD_MESSAGE = 'Blocked by Octipus: network/API calls from the shell bypass registered tools. '
  + 'Use Octipus mcp_list_tools/mcp_call_tool for MCP servers, or list_tools/describe_tool/call_discovered_tool for integrations. '
  + 'If no suitable tool exists, re-run the command with the comment `# octipus-fallback: <reason>` appended.';

/**
 * Why `command` is blocked, or null when it may run. Serialized verbatim into
 * the hook script (`toString`), so it must stay self-contained: no references
 * outside its own body.
 */
export function shellGuardBlockReason(command: string): string | null {
  if (/#\s*octipus-fallback:[ \t]*\S/.test(command)) return null;
  // ponytail: first word per segment, not a shell parser; quoted separators split early, which only ever over-blocks.
  const head = (segment: string): string => (segment.trim()
    .replace(/^(?:\w+=\S*\s+|(?:sudo|exec|env|time|&|\()\s*)+/i, '')
    .match(/^["']?([^\s"']+)/)?.[1] ?? '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd)$/, '');
  // git, builds, tests and package managers never make these calls themselves; commit messages may mention them.
  const segments = command.split(/&&|\|\||[;|\n]|\$\(|`/).filter(segment => head(segment) !== 'git');
  const heads = segments.map(head);
  if (heads.some(h => ['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod'].includes(h))
    || segments.some(segment => /\bInvoke-(WebRequest|RestMethod)\b|Net\.WebClient|System\.Net\.Http|Start-BitsTransfer/i.test(segment))) {
    return 'shell HTTP client';
  }
  if (heads.some(h => /^(python[\d.]*|py|node|bun|deno)$/.test(h))
    && /urllib|\brequests\b|http\.client|httpx|aiohttp|\bfetch\s*\(|\bhttps?\.(request|get)\s*\(|['"](node:)?https?['"]|XMLHttpRequest|WebSocket|\bsocket\b/.test(command)) {
    return 'network call from a script';
  }
  if (segments.some(segment => /(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?\/mcp\b/i.test(segment))) return 'local MCP endpoint';
  return null;
}

/**
 * The hook body. Reads the vendor's PreToolUse payload from stdin: Claude and
 * Codex send `tool_input.command` and read `hookSpecificOutput`; agy sends
 * `toolCall.args.CommandLine` and reads `{decision, reason}`. Unparseable
 * input fails open: a guard bug must not wedge every shell call.
 */
export function shellGuardScript(): string {
  // esbuild keepNames (tsx) wraps inner functions in __name(); vitest's transform doesn't, so tests can't see it.
  return `const __name = fn => fn;
const blockReason = ${shellGuardBlockReason.toString()};
const MESSAGE = ${JSON.stringify(SHELL_GUARD_MESSAGE)};
let raw = '';
process.stdin.on('data', chunk => { raw += chunk; }).on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const agy = !!(input && input.toolCall);
  const command = agy ? input.toolCall.args && input.toolCall.args.CommandLine : input && input.tool_input && input.tool_input.command;
  const reason = typeof command === 'string' ? blockReason(command) : null;
  if (!reason) return;
  const message = MESSAGE + ' (' + reason + ')';
  process.stdout.write(JSON.stringify(agy ? { decision: 'deny', reason: message }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } }));
});
`;
}

/** Content is fixed per build, so write once per process and reuse. */
let scriptPath: string | null = null;

export function getShellGuardScriptPath(): string {
  if (scriptPath && existsSync(scriptPath)) return scriptPath;
  const dir = join(tmpdir(), 'octipus-cli');
  mkdirSync(dir, { recursive: true });
  scriptPath = join(dir, 'shell-guard.cjs');
  writeFileSync(scriptPath, shellGuardScript(), 'utf-8');
  return scriptPath;
}

/** Hook command line. Codex runs Windows hooks in PowerShell, which needs `&` to call a quoted path. */
export function shellGuardHookCommand(powershell = false): string {
  return `${powershell ? '& ' : ''}"${process.execPath}" "${getShellGuardScriptPath()}"`;
}
