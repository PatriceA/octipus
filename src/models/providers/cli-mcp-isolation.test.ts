import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { claudeCodeConfig, codexCliConfig, glmCliConfig, kimiCliConfig, vibeCliConfig } from './cli-provider';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
const mockCodexList = (stdout: string) => vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
  cb(null, stdout, '');
  return undefined as never;
}) as never);

/**
 * Hole 1: the one-shot CLI provider path (`CLIProvider.complete`) is a plain
 * text completion used as a MODEL, not an agent — it needs zero tools. Before
 * this change it built argv with no MCP isolation at all, silently loading
 * the host's entire MCP config alongside octipus's own (measured: 150-180
 * tool schemas across both).
 */
describe('one-shot CLI provider — MCP isolation (Hole 1)', () => {
  it('Claude Code: adds --strict-mcp-config + a reusable empty --mcp-config file', () => {
    const args = claudeCodeConfig.buildArgs('hi');
    expect(args).toContain('--strict-mcp-config');
    const i = args.indexOf('--mcp-config');
    expect(i).toBeGreaterThanOrEqual(0);
    const configPath = args[i + 1];
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ mcpServers: {} });
    // Same file reused across calls — constant content, no per-call litter.
    const again = claudeCodeConfig.buildArgs('bye');
    expect(again[again.indexOf('--mcp-config') + 1]).toBe(configPath);
  });

  it('z.ai GLM and Moonshot Kimi (Claude-binary vendors) get the same isolation', () => {
    for (const cfg of [glmCliConfig, kimiCliConfig]) {
      const args = cfg.buildArgs('hi');
      expect(args).toContain('--strict-mcp-config');
      expect(args).toContain('--mcp-config');
    }
  });

  it('Codex CLI: has no isolation via the sync buildArgs alone (fallback only, never reached in practice)', () => {
    // `-c mcp_servers={}` does NOT disable configured servers (verified live
    // 2026-09-16: it merges into config.toml rather than replacing it), so
    // there is no safe sync argv for codex — buildArgsAsync is required.
    expect(codexCliConfig.buildArgs('')).toEqual(['exec', '--json', '-']);
    expect(codexCliConfig.buildArgsAsync).toBeTypeOf('function');
  });

  it('Codex CLI: buildArgsAsync discovers the effective MCP servers and disables each by name', async () => {
    mockCodexList(JSON.stringify([{ name: 'fintus', enabled: true }, { name: 'other' }]));
    const args = await codexCliConfig.buildArgsAsync!('', '/some/cwd');
    expect(args).toEqual(['exec', '--json', '-c', 'mcp_servers={"fintus"={enabled=false},"other"={enabled=false}}', '-']);
  });

  it('Codex CLI: buildArgsAsync omits the -c override entirely when nothing is configured', async () => {
    mockCodexList('[]');
    const args = await codexCliConfig.buildArgsAsync!('', '/some/cwd');
    expect(args).toEqual(['exec', '--json', '-']);
  });

  it('Codex CLI: buildArgsAsync falls back to --ignore-user-config when discovery cannot run (does not fail the completion)', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
      cb(new Error('boom'), '', '');
      return undefined as never;
    }) as never);
    const args = await codexCliConfig.buildArgsAsync!('', '/some/cwd');
    expect(args).toEqual(['exec', '--json', '--ignore-user-config', '-']);
  });

  it('Mistral Vibe: buildEnv points VIBE_HOME at an ephemeral home (or is absent when vibe is unset up)', async () => {
    expect(vibeCliConfig.buildEnv).toBeTypeOf('function');
    const env = await vibeCliConfig.buildEnv!();
    // Either isolated (VIBE_HOME set to a fresh dir) or vibe was never set up
    // on this machine (empty env, falls back to vibe's own defaults) — never
    // an env that still points at the real, unscoped ~/.vibe.
    if (env.VIBE_HOME) {
      expect(env.VIBE_HOME).not.toBe(process.env.VIBE_HOME);
    } else {
      expect(env).toEqual({});
    }
  });
});
