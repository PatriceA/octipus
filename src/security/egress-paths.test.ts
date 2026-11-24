/**
 * Outbound paths a tool takes beyond the generic fetch: artifact data sources
 * and collectors (SSRF guard + policy, a subject for scheduled refreshes), the
 * visual tool, git remotes, `gh repo clone`, and the actions the policy cannot
 * judge (refused under requireEnforcement).
 */
import dns from 'node:dns';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { egressPolicySchema } from '@/shared/egress-policy';

const state = vi.hoisted(() => ({
  policy: undefined as unknown,
  audits: [] as Array<Record<string, unknown>>,
  source: null as Record<string, unknown> | null,
  statuses: [] as Array<Record<string, unknown>>,
  captures: [] as string[],
}));

vi.mock('@/config', async (orig) => {
  const real = await orig<typeof import('@/config')>();
  return {
    ...real,
    getConfig: () => {
      let base: Record<string, any> = {};
      try { base = real.getConfig() as unknown as Record<string, any>; } catch { /* not loaded in this lane */ }
      return { ...base, security: { ...(base.security ?? {}), egressPolicy: state.policy } };
    },
  };
});
vi.mock('@/db/repositories/audit-repository', () => ({
  auditRepository: { log: async (entry: Record<string, unknown>) => { state.audits.push(entry); } },
}));
vi.mock('@/db/repositories/artifacts-repository', () => ({
  artifactsRepository: {
    getSource: async () => state.source,
    getById: async () => ({ id: 'a1', workspaceId: null }),
    isSourceInArchivedSpace: async () => false,
    spaceOfSource: async () => null,
    updateSourceStatus: async (_id: string, status: Record<string, unknown>) => { state.statuses.push(status); },
  },
}));
// Tool middleware without a database: every call allowed, run directly.
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: async () => ({ level: 'ALLOW', source: 'policy' }) }) }));
vi.mock('@/security/approval-route', () => ({ routeApprovalFor: async () => ({ route: 'execute', source: 'policy' }) }));
vi.mock('@/core/action-recovery', async (orig) => ({ ...(await orig<typeof import('@/core/action-recovery')>()), actionRecovery: { run: async (_c: unknown, _t: unknown, _n: unknown, _a: unknown, run: () => Promise<unknown>) => run() } }));
vi.mock('@/core/artifacts/events', () => ({ publishArtifactDataUpdated: () => {}, publishArtifactSourceError: () => {} }));
vi.mock('@/visual/screenshot', () => ({
  ScreenshotCapture: class {
    async init() {}
    async navigate(url: string) { state.captures.push(url); }
    async capture() { return { image: Buffer.from(''), format: 'png', width: 1, height: 1, url: '', timestamp: 0 }; }
    async close() {}
  },
}));

const { withEgressSubject, evaluateEgress } = await import('./egress-policy');
const { gitRemoteTarget, enforceGitRemotes } = await import('./git-egress');
const { unjudgedEgressRefusal, cliNativeToolsRefusal } = await import('./egress-coverage');

beforeEach(() => {
  state.policy = egressPolicySchema.parse({});
  state.audits = [];
  state.statuses = [];
  state.captures = [];
  vi.spyOn(dns.promises, 'resolve4').mockImplementation(async () => ['93.184.216.34']);
  vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('no AAAA'));
});
afterEach(() => vi.restoreAllMocks());

const asTool = <T>(tool: string, run: () => Promise<T>) => withEgressSubject({ tool, userId: 'u1' }, run);
const METADATA = 'http://169.254.169.254/latest/meta-data/';

describe('artifact data sources and collectors', () => {
  test.each(['http-json', 'http-text', 'html-scrape', 'rss'])('collector %s refuses a metadata address (SSRF guard), whatever the policy', async (name) => {
    const mod = await import(`@/core/artifacts/toolbox/collectors/${name}`);
    const collector = mod.default ?? Object.values(mod)[0];
    const params = name === 'html-scrape' ? { url: METADATA, row: 'a', fields: { t: 'a' } } : { url: METADATA };
    await expect(collector.execute(params, { principalId: 'p', workspaceId: null })).rejects.toThrow(/SSRF guard/);
  }, 10_000);

  test('a scheduled refresh (no tool call) is judged as the artifacts tool of its owner', async () => {
    state.policy = egressPolicySchema.parse({ tools: { artifacts: { default: 'deny', rules: [{ action: 'allow', host: 'feeds.example' }] } } });
    state.source = { id: 's1', artifactId: 'a1', kind: 'http', name: 'n', principalId: 'owner-1', configJson: { url: 'https://elsewhere.example/data' } };
    const { refreshSource } = await import('@/core/artifacts/refresh');
    const result = await refreshSource('s1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/elsewhere\.example:443 \(https\) is denied by the operator's egress policy for tool artifacts — tool artifacts default \(deny\)/);
    await vi.waitFor(() => expect(state.audits[0]).toMatchObject({ userId: 'owner-1', details: { tool: 'artifacts', path: 'fetch' } }));
  });

  test('an http source to a metadata address is refused by the SSRF guard', async () => {
    state.source = { id: 's2', artifactId: 'a1', kind: 'http', name: 'n', principalId: 'owner-1', configJson: { url: METADATA } };
    const { refreshSource } = await import('@/core/artifacts/refresh');
    expect((await refreshSource('s2')).error).toMatch(/SSRF guard/);
  }, 10_000);
});

describe('visual', () => {
  test('a metadata address and a denied host are refused before any browser opens', async () => {
    const { VisualTool } = await import('@/tools/visual');
    const tool = new VisualTool() as unknown as { captureUrls(urls: Array<{ url: string }>, b: string): Promise<unknown> };
    await expect(asTool('visual', () => tool.captureUrls([{ url: METADATA }], 'chromium'))).rejects.toThrow(/URL blocked/);
    state.policy = egressPolicySchema.parse({ rules: [{ action: 'deny', host: 'denied.example' }] });
    await expect(asTool('visual', () => tool.captureUrls([{ url: 'https://ok.example/' }, { url: 'https://denied.example/' }], 'chromium'))).rejects.toThrow(/denied\.example:443/);
    expect(state.captures).toEqual([]);
  });
});

describe('git remotes', () => {
  test.each([
    ['https://github.com/o/r.git', { host: 'github.com', port: 443, scheme: 'https' }],
    ['http://git.example:8080/r', { host: 'git.example', port: 8080, scheme: 'http' }],
    ['ssh://git@git.example:2222/o/r', { host: 'git.example', port: 2222, scheme: 'ssh' }],
    ['git@github.com:o/r.git', { host: 'github.com', port: 22, scheme: 'ssh' }],
    ['github.com:o/r', { host: 'github.com', port: 22, scheme: 'ssh' }],
    ['/srv/repos/r.git', null],
    ['./r', null],
    ['file:///srv/r.git', null],
    ['C:\\repos\\r', process.platform === 'win32' ? null : 'unjudgeable'],
    ['c:/repo', process.platform === 'win32' ? null : { host: 'c', port: 22, scheme: 'ssh' }],
    ['git://git.example/r', 'unjudgeable'],
    ['ext::sh -c touch% /tmp/x', 'unjudgeable'],
  ])('%s', (spec, expected) => {
    expect(gitRemoteTarget(spec)).toEqual(expected);
  });

  test('a denied remote, an ssh remote under an https-only allow, and an unjudgeable transport are refused', async () => {
    state.policy = egressPolicySchema.parse({ default: 'deny', rules: [{ action: 'allow', host: 'github.com', schemes: ['https'] }] });
    const subject = { tool: 'git' };
    const resolve = async () => ['140.82.112.3'];
    await expect(enforceGitRemotes(['https://github.com/o/r.git'], subject, resolve)).resolves.toBeUndefined();
    await expect(enforceGitRemotes(['git@github.com:o/r.git'], subject, resolve)).rejects.toThrow(/github\.com:22 \(ssh\)/);
    await expect(enforceGitRemotes(['https://gitlab.example/o/r'], subject, resolve)).rejects.toThrow(/default \(deny\)/);
    await expect(enforceGitRemotes(['ext::sh -c id'], subject, resolve)).rejects.toThrow(/cannot judge/);
    await expect(enforceGitRemotes(['/local/path'], subject, resolve)).resolves.toBeUndefined();
  });

  test('the git tool judges the URL git will use (insteadOf applied) before cloning', async () => {
    const home = mkdtempSync(join(tmpdir(), 'octi-git-egress-'));
    const prev = { HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
    try {
      process.env.HOME = home;
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      execFileSync('git', ['config', '--global', 'url.https://evil.example/.insteadOf', 'https://allowed.example/'], { env: { ...process.env, GIT_CONFIG_COUNT: '0' } });
      state.policy = egressPolicySchema.parse({ default: 'deny', rules: [{ action: 'allow', host: 'allowed.example' }] });
      const { GitTool } = await import('@/tools/git');
      const tool = new GitTool();
      await tool.initialize();
      const clone = tool.getToolHandlers().find((h) => h.name.endsWith('clone'))!;
      const context = { id: 'agent-1', userId: 'u1', sessionId: 's1', role: 'coding', status: 'running' } as never;
      await expect(clone.execute({ url: 'https://allowed.example/o/r.git', path: join(home, 'r') }, context)).rejects.toThrow(/evil\.example:443/);
    } finally {
      process.env.HOME = prev.HOME;
      if (prev.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = prev.GIT_CONFIG_NOSYSTEM;
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('gh repo clone is judged on the URL gh resolves (its host and git_protocol), and option-like values are refused', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'octi-fake-gh-'));
    const marker = join(bin, 'cloned');
    const protocolFile = join(bin, 'protocol');
    writeFileSync(protocolFile, 'ssh');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"url":"https://ghe.example/o/r","sshUrl":"git@ghe.example:o/r.git","parent":{"name":"up","owner":{"login":"p"}}}' ;;
  "config get") cat "${protocolFile}" ;;
  "repo clone") touch "${marker}" ;;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const { GitHubTool } = await import('@/tools/github');
      const tool = new GitHubTool();
      await tool.initialize();
      const clone = tool.getToolHandlers().find((h) => h.name.endsWith('repo_clone'))!;
      const context = { id: 'agent-1', userId: 'u1', sessionId: 's1', role: 'coding', status: 'running' } as never;
      // The server's GH_HOST says github.com; gh is configured for ghe.example over ssh.
      state.policy = egressPolicySchema.parse({ default: 'deny', rules: [{ action: 'allow', host: 'github.com' }, { action: 'allow', host: 'ghe.example', schemes: ['https'] }] });
      await expect(clone.execute({ repo: 'o/r' }, context)).rejects.toThrow(/ghe\.example:22 \(ssh\)/);
      expect(existsSync(marker)).toBe(false);
      writeFileSync(protocolFile, 'https');
      await expect(clone.execute({ repo: 'o/r' }, context)).resolves.toBeDefined();
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      await expect(clone.execute({ repo: '--upload-pack=touch /tmp/x' }, context)).rejects.toThrow(/must not start with "-"|Invalid repo/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = previousPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('github: a host named by the model is judged before gh talks to it', () => {
  let bin: string;
  let calls: string;
  let previousPath: string | undefined;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'octi-fake-gh2-'));
    calls = join(bin, 'calls');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "${calls}"\necho '[]'\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
  });
  afterEach(() => { process.env.PATH = previousPath; rmSync(bin, { recursive: true, force: true }); });

  const handlers = async () => {
    const { GitHubTool } = await import('@/tools/github');
    const tool = new GitHubTool();
    await tool.initialize();
    return tool.getToolHandlers();
  };
  const context = { id: 'agent-1', userId: 'u1', sessionId: 's1', role: 'coding', status: 'running' } as never;
  const called = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');

  test.each([
    ['repo_clone', { repo: 'https://secret-data.attacker.example/o/r' }],
    ['repo_clone', { repo: 'secret-data.attacker.example/o/r' }],
    ['repo_clone', { repo: 'git@secret-data.attacker.example:o/r.git' }],
    ['issue_list', { repo: 'https://secret-data.attacker.example/o/r' }],
    ['repo_view', { repo: 'secret-data.attacker.example/o/r' }],
  ])('%s %j is refused and gh never runs', async (action, args) => {
    state.policy = egressPolicySchema.parse({ default: 'deny', rules: [{ action: 'allow', host: 'github.com' }] });
    const handler = (await handlers()).find((h) => h.name.endsWith(action))!;
    // A URL is not a repository outside repo_clone; a HOST/owner/name or a clone URL is judged.
    await expect(handler.execute(args, context)).rejects.toThrow(/secret-data\.attacker\.example:443 \(https\) is denied|Invalid repo/);
    expect(called()).toBe('');
  });

  test('owner/name is judged on the host gh will use', async () => {
    const previous = process.env.GH_HOST;
    process.env.GH_HOST = 'ghe.example';
    try {
      state.policy = egressPolicySchema.parse({ default: 'deny', rules: [{ action: 'allow', host: 'github.com' }] });
      const handler = (await handlers()).find((h) => h.name.endsWith('issue_list'))!;
      await expect(handler.execute({ repo: 'o/r' }, context)).rejects.toThrow(/ghe\.example:443/);
      expect(called()).toBe('');
      state.policy = egressPolicySchema.parse({});
      await expect(handler.execute({ repo: 'o/r' }, context)).resolves.toBeDefined();
      expect(called()).toContain('issue list -R o/r');
    } finally { if (previous === undefined) delete process.env.GH_HOST; else process.env.GH_HOST = previous; }
  });

  test.each(['issue_view', 'issue_comment', 'issue_close', 'pr_view', 'pr_review', 'pr_merge', 'pr_comment', 'pr_diff', 'pr_checks', 'set_labels', 'set_milestone'])('%s refuses a number given as a URL; gh never runs', async (action) => {
    const handler = (await handlers()).find((h) => h.name.endsWith(action))!;
    await expect(handler.execute({ repo: 'octo/x', number: 'https://localhost/secret-data/r/issues/1', body: 'b', event: 'comment', add: 'l' }, context)).rejects.toThrow(/positive integer|Invalid number/);
    expect(called()).toBe('');
  });

  test.each([
    ['pr_create', { repo: 'o/r', title: 't', head: 'https://evil.example/x' }],
    ['pr_create', { repo: 'o/r', title: 't', base: '--web' }],
    ['pr_list', { repo: 'o/r', head: 'a..b' }],
    ['workflow_run', { repo: 'o/r', workflow: 'https://evil.example/w.yml' }],
    ['workflow_run', { repo: 'o/r', workflow: 'ci.yml', ref: 'main --x' }],
    ['release_create', { repo: 'o/r', tag: 'v1 --draft' }],
    ['repo_create', { name: 'https://evil.example/o/r' }],
    ['repo_fork', { repo: 'o/r', org: 'evil.example/x' }],
    ['run_view', { repo: 'o/r', run_id: 'https://evil.example/1' }],
    ['job_log', { repo: 'o/r', job_id: '12/../x' }],
    ['issue_list', { repo: 'o/r', state: 'open --jq .' }],
    ['issue_list', { repo: 'o/r', limit: 'all' }],
    ['pr_review', { repo: 'o/r', number: 1, event: 'web' }],
    ['pr_merge', { repo: 'o/r', number: 1, method: 'admin' }],
    ['issue_view', { repo: 'https://evil.example/o/r', number: 1 }],
    ['issue_view', { repo: 'o/r/extra/parts', number: 1 }],
  ])('%s %j is refused before gh runs', async (action, args) => {
    const handler = (await handlers()).find((h) => h.name.endsWith(action))!;
    await expect(handler.execute(args, context)).rejects.toThrow();
    expect(called()).toBe('');
  });

  test('well-formed values reach gh: owner:branch heads, refs, workflows, integers', async () => {
    const all = await handlers();
    await all.find((h) => h.name.endsWith('pr_create'))!.execute({ repo: 'o/r', title: 'A title -- with dashes', body: '- a list item', head: 'someone:feature/x', base: 'main' }, context);
    await all.find((h) => h.name.endsWith('workflow_run'))!.execute({ repo: 'o/r', workflow: 'ci.yml', ref: 'release/1.2' }, context);
    await all.find((h) => h.name.endsWith('issue_view'))!.execute({ repo: 'o/r', number: '12' }, context);
    const log = called();
    expect(log).toContain('pr create -R o/r --title A title -- with dashes --body - a list item --base main --head someone:feature/x');
    expect(log).toContain('workflow run ci.yml -R o/r --ref release/1.2');
    expect(log).toContain('issue view 12 -R o/r');
  });

  test('get_file never hands gh an absolute URL', async () => {
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "${calls}"\ncase "$*" in *vnd.github.raw*) echo raw-content ;; *) echo '{"type":"file","download_url":"https://evil.example/blob"}' ;; esac\n`);
    const handler = (await handlers()).find((h) => h.name.endsWith('get_file'))!;
    await expect(handler.execute({ repo: 'o/r', path: 'big.bin' }, context)).resolves.toMatchObject({ content: 'raw-content' });
    expect(called()).not.toContain('evil.example');
    expect(called()).toContain('api -H Accept: application/vnd.github.raw repos/o/r/contents/big.bin');
  });

  test('repo_list refuses a visibility outside its enum', async () => {
    const handler = (await handlers()).find((h) => h.name.endsWith('repo_list'))!;
    await expect(handler.execute({ visibility: 'public --jq .' }, context)).rejects.toThrow(/visibility must be/);
    expect(called()).toBe('');
  });

  test('the git that gh starts gets hooks, fsmonitor, pagers and editors off, after any entries already there', async () => {
    const { ghEnv } = await import('@/utils/gh');
    const env = ghEnv();
    const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`);
    expect(pairs).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.editor=true', 'sequence.editor=true', 'protocol.ext.allow=never']));
    const { withHardenedGitEnv } = await import('./git-hardening');
    const appended = withHardenedGitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' });
    expect(appended.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(appended.GIT_CONFIG_KEY_1).toBe('core.hooksPath');
  });
});

describe('what the policy cannot judge', () => {
  test('is refused under requireEnforcement, and only then', () => {
    expect(unjudgedEgressRefusal('docker', 'build_image')).toBeNull();
    state.policy = egressPolicySchema.parse({ default: 'deny' });
    expect(unjudgedEgressRefusal('docker', 'build_image')).toBeNull();
    state.policy = egressPolicySchema.parse({ default: 'deny', requireEnforcement: true });
    expect(unjudgedEgressRefusal('docker', 'build_image')).toMatch(/docker\.build_image is refused/);
    expect(unjudgedEgressRefusal('browser-ext', 'navigate')).toMatch(/user's own browser/);
    expect(unjudgedEgressRefusal('mcp_admin', 'mcp_add_server')).toMatch(/refused/);
    expect(unjudgedEgressRefusal('test_container', 'run')).toMatch(/test_container\.run is refused.*bridge network/);
    expect(unjudgedEgressRefusal('docker', 'list_containers')).toBeNull();
    expect(cliNativeToolsRefusal(false)).toMatch(/vendor-native tools/);
    expect(cliNativeToolsRefusal(true)).toBeNull();
  });

  test('BaseTool refuses such an action before running it', async () => {
    const { BaseTool } = await import('@/tools/base-tool');
    const ran = vi.fn(async () => 'built');
    class FakeDocker extends BaseTool {
      readonly id = 'docker'; readonly name = 'docker'; readonly version = '1'; readonly description = 'd';
      getManifest() { return { id: this.id, name: this.name, version: this.version, description: this.description, permissions: [], tools: [] }; }
      protected async registerTools() { this.registerTool('build_image', 'Build', { type: 'object' }, ran, { readOnly: true }); }
    }
    const tool = new FakeDocker();
    await tool.initialize();
    state.policy = egressPolicySchema.parse({ requireEnforcement: true });
    const context = { id: 'agent-1', userId: 'u1', sessionId: 's1', role: 'coding', status: 'running' } as never;
    await expect(tool.getToolHandlers()[0].execute({}, context)).rejects.toThrow(/cannot be judged/);
    expect(ran).not.toHaveBeenCalled();
  });
});

describe('roles along the spawn chain', () => {
  test('every spawn path appends the parent\'s role to the chain', async () => {
    const { withEgressRoleChain } = await import('./egress-policy');
    expect(withEgressRoleChain({ pipelineId: 'p' }, { role: 'coding', metadata: { egressRoleChain: ['general'] } })).toEqual({ pipelineId: 'p', egressRoleChain: ['general', 'coding'] });
    expect(withEgressRoleChain(undefined, { role: 'general' })).toEqual({ egressRoleChain: ['general'] });
  });

  test('a child is judged under its own role and every ancestor\'s', () => {
    const policy = egressPolicySchema.parse({ roles: { coding: { default: 'deny' }, research: { rules: [{ action: 'allow', host: 'arxiv.org' }] } } });
    const target = { host: 'arxiv.org', port: 443, scheme: 'https' as const };
    expect(evaluateEgress(policy, { tool: 'websearch', role: 'research' }, target, ['93.184.216.34']).allowed).toBe(true);
    const child = evaluateEgress(policy, { tool: 'websearch', role: 'research', roles: ['general', 'coding'] }, target, ['93.184.216.34']);
    expect(child).toMatchObject({ allowed: false, rule: 'role coding default (deny)' });
  });
});
