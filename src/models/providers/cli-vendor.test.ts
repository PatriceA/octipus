import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { CLI_TOOLS, CLIProvider, glmCliConfig, kimiCliConfig } from './cli-provider';

describe('GLM / Kimi CLI configs (Claude-binary + Anthropic endpoint)', () => {
  const realZai = process.env.ZAI_API_KEY;
  const realMoonshot = process.env.MOONSHOT_API_KEY;

  beforeEach(() => {
    process.env.ZAI_API_KEY = 'zai-test';
    process.env.MOONSHOT_API_KEY = 'moonshot-test';
  });
  afterEach(() => {
    if (realZai === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = realZai;
    if (realMoonshot === undefined) delete process.env.MOONSHOT_API_KEY; else process.env.MOONSHOT_API_KEY = realMoonshot;
    delete process.env.ZAI_CLI_MODEL;
    delete process.env.MOONSHOT_CLI_MODEL;
  });

  it('both are registered and reuse the claude binary + adapter', () => {
    expect(CLI_TOOLS).toContain(glmCliConfig);
    expect(CLI_TOOLS).toContain(kimiCliConfig);
    expect(glmCliConfig.binaryPath).toBe('claude');
    expect(kimiCliConfig.binaryPath).toBe('claude');
    expect(glmCliConfig.modelProvider).toBe('zai');
    expect(kimiCliConfig.modelProvider).toBe('moonshot');
    // adapter decouples arg-building/parsing dispatch from the display name.
    expect(glmCliConfig.adapter).toBe('Claude Code');
    expect(kimiCliConfig.adapter).toBe('Claude Code');
  });

  it('buildEnv throws a clear error when the vendor key is missing', async () => {
    delete process.env.ZAI_API_KEY;
    await expect(glmCliConfig.buildEnv!()).rejects.toThrow(/no API key configured.*ZAI_API_KEY/);
  });

  it('CLIProvider routes cli/glm and cli/kimi models', () => {
    const p = new CLIProvider();
    expect(p.supportsModel('cli/glm')).toBe(true);
    expect(p.supportsModel('cli/kimi')).toBe(true);
    expect(p.supportsModel('cli/moonshot')).toBe(true);
    expect(p.supportsModel('cli/zai')).toBe(true);
  });

  it('glm buildEnv points the claude binary at z.ai with the resolved token', async () => {
    const env = await glmCliConfig.buildEnv!();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('zai-test');
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.ANTHROPIC_MODEL).toBe('glm-4.6');
  });

  it('kimi buildEnv points the claude binary at Moonshot with the resolved token', async () => {
    const env = await kimiCliConfig.buildEnv!();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('moonshot-test');
    expect(env.ANTHROPIC_MODEL).toBe('kimi-k2-0711-preview');
  });

  it('model selection is overridable via env', async () => {
    process.env.ZAI_CLI_MODEL = 'glm-4.7';
    process.env.MOONSHOT_CLI_MODEL = 'kimi-k2.7-code';
    expect((await glmCliConfig.buildEnv!()).ANTHROPIC_MODEL).toBe('glm-4.7');
    expect((await kimiCliConfig.buildEnv!()).ANTHROPIC_MODEL).toBe('kimi-k2.7-code');
  });
});
