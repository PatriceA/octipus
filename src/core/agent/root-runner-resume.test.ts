import { describe, expect, it } from 'vitest';
import { assembleSystemPrompt, buildPreHookVolatileParts } from './root-runner';
import { CLIArgumentBuilder } from '@/core/cli-adapters';

describe('root prompt delivery', () => {
  it.each(['Claude Code', 'Codex CLI'])('preserves live guidance on a resumed %s turn', adapter => {
    const prompt = assembleSystemPrompt(['STATIC-PREFIX'], buildPreHookVolatileParts('MEMORY-BLOCK', ['sql-injection-attempt']));
    const built = new CLIArgumentBuilder().build(adapter, 'new question', {}, [prompt], prompt, 100_000, 'agent',
      { url: 'http://127.0.0.1:1', key: 'k', planMode: false, maxIterations: 4, workingDirectory: '/w', codexMcpServers: [] },
      { id: 'vendor-1', isFirstRun: false });
    const delivered = built.args.join(' ') + (built.stdinPrompt ?? '');
    expect(delivered).toContain('CURRENT DATE & TIME');
    expect(delivered).toContain('MEMORY-BLOCK');
    expect(delivered).toContain('sql-injection-attempt');
    expect(delivered).toContain('new question');
    expect(delivered).not.toContain('STATIC-PREFIX');
  });
});
