import { describe, expect, test, vi } from 'vitest';
import { assertNoCredentialTemplates } from './credential-boundary';
import { injectSecrets } from './secret-injector';

vi.mock('./vault', () => ({ getVault: vi.fn(() => { throw new Error('Vault must not be read'); }) }));

describe('vault content boundary', () => {
  test.each([
    { command: 'echo "$TOKEN" > leaked.txt', env: { TOKEN: '{{secret:CANARY}}' } },
    { command: 'node -e "encodeAndWrite(process.env.TOKEN)"', env: { TOKEN: '${vault.CANARY}' } },
    { content: '{{secret:CANARY}}' },
    { url: 'https://example.test/?token={{secret:CANARY}}' },
    { arguments: JSON.stringify({ nested: [{ template: '${vault.CANARY}' }] }) },
    { plan: { history: [{ details: '{{secret:MISSING_OR_DENIED}}' }] } },
  ])('rejects unsupported sinks before looking up a credential: %j', args => {
    expect(() => assertNoCredentialTemplates(args)).toThrow('Vault interpolation is disabled');
  });
  test('the legacy injector cannot return resolved plaintext or continue on denial', async () => {
    await expect(injectSecrets('{{secret:CANARY}}', { userId: 'user' })).rejects.toThrow('Vault interpolation is disabled');
    expect(await injectSecrets('Use configured connection CANARY', { userId: 'user' })).toEqual({
      content: 'Use configured connection CANARY', injectedSecrets: [], resolvedValues: [], errors: [],
    });
  });
  test('ordinary arrays and named integration selectors stay unchanged', () => {
    const args = { connection: 'warehouse', params: [1, true, null] };
    expect(() => assertNoCredentialTemplates(args)).not.toThrow();
    expect(args.params).toEqual([1, true, null]);
  });
});

test('general tool middleware refuses shell redirection and encoded/template writes before a callback starts', async () => {
  const { BaseTool } = await import('@/tools/base-tool');
  const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'credential-boundary-'));
  const target = join(dir, 'must-not-exist.txt');
  const run = vi.fn(async () => { writeFileSync(target, 'A callback must never receive a vault value'); return {}; });
  class ArbitrarySink extends BaseTool {
    readonly id = 'credential-boundary-test'; readonly name = 'sink'; readonly version = '1'; readonly description = 'Synthetic sink';
    getManifest() { return { id: this.id, name: this.name, version: this.version, description: this.description, permissions: [], tools: [] }; }
    protected async registerTools() {
      this.registerTool('run', 'Synthetic arbitrary execution sink', { type: 'object' }, run);
      this.registerTool('write', 'Synthetic direct file sink', { type: 'object' }, run, { injectSecrets: false });
    }
  }
  const sink = new ArbitrarySink(); await sink.initialize();
  try {
    for (const args of [
      { command: `printf '%s' "$TOKEN" > "${target}"`, env: { TOKEN: '{{secret:CANARY}}' } },
      { command: 'node template.js', env: { TOKEN: '${vault.CANARY}' } },
      { command: 'node encode-env.js', arguments: [{ TOKEN: '{{secret:CANARY}}' }] },
      { path: target, content: '${vault.CANARY}' },
    ]) {
      for (const tool of sink.getToolHandlers()) {
        await expect(tool.execute(args, {} as never)).rejects.toThrow('Vault interpolation is disabled');
      }
    }
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(target)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
