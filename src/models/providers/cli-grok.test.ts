import { describe, expect, it } from 'vitest';
import { CLIProvider, CLI_TOOLS, grokBuildConfig } from './cli-provider';
import { CLIOutputParser, CLIArgumentBuilder } from '@/core/cli-adapters';
import { canResume, validateScopedExtraArgs } from '@/shared/cli-capabilities';
import { buildChildEnv } from '@/core/cli-child-env';

describe('Grok Build CLI integration', () => {
  it('discovers aliases without confusing the xAI API provider with the CLI', () => {
    const provider = new CLIProvider();
    expect(CLI_TOOLS).toContain(grokBuildConfig);
    for (const id of ['cli/grok-build', 'cli/grok']) expect(provider.supportsModel(id)).toBe(true);
    expect(provider.supportsModel('grok-4')).toBe(false);
    expect(canResume('Grok Build')).toBe(true);
    expect(grokBuildConfig.toolLessArgs).toBeUndefined();
    expect(() => grokBuildConfig.buildArgs('text')).toThrow('agent model');
    expect(() => validateScopedExtraArgs('Grok Build', ['--always-approve'])).toThrow('Unsupported extraArgs');
    expect(() => new CLIArgumentBuilder().build('Grok Build', 'hello', {}, [])).toThrow('scoped Octipus tool bridge');
  });

  it('uses existing login without inheriting other server secrets', () => {
    const env = buildChildEnv(grokBuildConfig);
    expect(env).not.toHaveProperty('XAI_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it('parses the real Messages-shaped stream and accounts for cache only once', () => {
    const usages: Array<{ input: number; output: number; total: number; cacheRead?: number }> = [];
    let turns = 0;
    const errors: string[] = [];
    const events: unknown[] = [];
    const parser = new CLIOutputParser('a', 'cli/grok-build', (_type, data) => events.push(data), {
      onTurn: () => { turns++; }, onToolCall: () => {}, onTokenUsage: usage => usages.push(usage), onRunError: error => errors.push(error),
    });
    parser.parse({ type: 'system', subtype: 'init', session_id: 'grok-session' }, 'Grok Build');
    parser.parse({ type: 'assistant', message: { id: 'msg_0', content: [{ type: 'text', text: 'Done' }],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } } }, 'Grok Build');
    const result = parser.parse({ type: 'result', subtype: 'success', result: 'Done', num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } }, 'Grok Build');
    expect(result).toEqual({ text: 'Done', replace: true });
    expect(turns).toBe(1);
    expect(usages.reduce((sum, usage) => sum + usage.total, 0)).toBe(210);
    expect(usages.reduce((sum, usage) => sum + usage.input, 0)).toBe(190);
    expect(errors).toEqual([]);
    expect(events.length).toBeGreaterThan(0);
    parser.parse({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 1 }, 'Grok Build');
    expect(errors.at(-1)).toContain('Grok Build hit the max-turns limit');
  });
});
