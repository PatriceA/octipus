import { spawnSync } from 'node:child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { CLIArgumentBuilder } from './cli-adapters';
import { getShellGuardScriptPath, SHELL_GUARD_TOOL_MATCHER, shellGuardBlockReason } from './cli-shell-guard';

describe('shellGuardBlockReason', () => {
  it.each([
    'curl -s http://localhost:51789/mcp -d @req.json',
    'cd /tmp && curl.exe https://api.example.com',
    'wget -qO- https://example.com',
    'Invoke-RestMethod -Uri http://127.0.0.1:3005/api -Method Post',
    '$r = Invoke-WebRequest https://example.com',
    'iwr https://example.com',
    `python -c "import urllib.request; print(urllib.request.urlopen('http://x').read())"`,
    `python3 - <<'EOF'\nimport requests\nrequests.post('http://127.0.0.1:51789/mcp')\nEOF`,
    `node -e "fetch('http://localhost:3005/api').then(r => r.text())"`,
    `bun -e "await fetch('https://example.com')"`,
    `ruby -e 'Net::HTTP.post(URI("http://localhost:51789/mcp"), "{}")'`,
  ])('blocks %s', command => {
    expect(shellGuardBlockReason(command)).not.toBeNull();
  });

  it.each([
    'git status',
    'git commit -m "replace curl client with mcp_call_tool"',
    'npm test',
    'npm run build --prefix mcp-server',
    'bun run compile',
    'bun test tests/foo.test.ts',
    'pnpm install',
    'cargo build --release',
    'python scripts/gen.py --out dist',
    'node --test',
    'curl -s http://localhost:51789/mcp # octipus-fallback: server not registered in Octipus',
  ])('allows %s', command => {
    expect(shellGuardBlockReason(command)).toBeNull();
  });

  it('needs a reason after the fallback marker', () => {
    expect(shellGuardBlockReason('curl https://x # octipus-fallback:')).not.toBeNull();
  });
});

describe('shell guard hook script', () => {
  const run = (input: unknown) => {
    const out = spawnSync(process.execPath, [getShellGuardScriptPath()], { input: JSON.stringify(input), encoding: 'utf8' });
    expect(out.status).toBe(0);
    return out.stdout ? JSON.parse(out.stdout) : null;
  };

  it('denies in the Claude/Codex format and names the Octipus tools', () => {
    const out = run({ tool_name: 'Bash', tool_input: { command: 'curl https://x' } });
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('mcp_call_tool');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('# octipus-fallback: <reason>');
  });

  it('denies in the Antigravity format', () => {
    expect(run({ toolCall: { name: 'run_command', args: { CommandLine: 'wget https://x' } } })).toMatchObject({ decision: 'deny' });
  });

  it('stays silent for allowed commands and unparseable input', () => {
    expect(run({ tool_name: 'Bash', tool_input: { command: 'npm test' } })).toBeNull();
    const out = spawnSync(process.execPath, [getShellGuardScriptPath()], { input: 'not json', encoding: 'utf8' });
    expect([out.status, out.stdout]).toEqual([0, '']);
  });
});

describe('shell guard injection per adapter', () => {
  const builder = new CLIArgumentBuilder();
  const connection = { url: 'http://127.0.0.1:43123', key: 'k', planMode: false, maxIterations: 7, workingDirectory: '/session/project', codexMcpServers: [] as Array<{ name: string }>, shellGuard: true };
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('Claude Code: --settings file with a PreToolUse hook on the shell tools', () => {
    const { args } = builder.build('Claude Code', 'task', {}, [], null, 100, 'test', connection);
    const settings = JSON.parse(readFileSync(after(args, '--settings'), 'utf8'));
    expect(settings.hooks.PreToolUse[0].matcher).toBe(SHELL_GUARD_TOOL_MATCHER);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(getShellGuardScriptPath());
  });

  it('Codex CLI: -c hooks.PreToolUse plus the hook-trust bypass', () => {
    const { args } = builder.build('Codex CLI', 'task', {}, [], null, 100, 'test', connection);
    expect(args).toContain('--dangerously-bypass-hook-trust');
    const hooks = args.find(arg => arg.startsWith('hooks.PreToolUse='))!;
    if (process.platform === 'win32') {
      // cmd.exe carries this value: no quote, space or pipe may survive into it.
      expect(hooks).not.toMatch(/["\s|]/);
      expect(readFileSync(hooks.match(/command='([^']+)'/)![1], 'utf8')).toContain(getShellGuardScriptPath());
    } else {
      expect(hooks).toContain(`matcher = "${SHELL_GUARD_TOOL_MATCHER}"`);
      expect(hooks).toContain(JSON.stringify(getShellGuardScriptPath()).slice(1, -1));
    }
  });

  it('Antigravity: --add-dir customization root with .agents/hooks.json', () => {
    const { args } = builder.build('Antigravity', 'task', {}, [], null, 100, 'test', connection);
    const hooks = JSON.parse(readFileSync(join(after(args, '--add-dir'), '.agents', 'hooks.json'), 'utf8'));
    expect(hooks['octipus-shell-guard'].PreToolUse[0].matcher).toBe('run_command');
  });

  it('is absent when the setting is off', () => {
    const off = { ...connection, shellGuard: false };
    expect(builder.build('Claude Code', 'task', {}, [], null, 100, 'test', off).args).not.toContain('--settings');
    expect(builder.build('Codex CLI', 'task', {}, [], null, 100, 'test', off).args).not.toContain('--dangerously-bypass-hook-trust');
    expect(builder.build('Antigravity', 'task', {}, [], null, 100, 'test', off).args).not.toContain('--add-dir');
  });
});
