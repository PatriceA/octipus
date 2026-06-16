import { describe, expect, it } from 'bun:test';
import { vibeCliConfig } from './cli-provider';

// Captured shape of `vibe -p "..." --output json`: a JSON array of all messages
// (system, user, assistant). The answer is the last role:"assistant" element's
// content. The array carries no usage/cost fields.
const VIBE_JSON_FIXTURE = JSON.stringify([
  { role: 'system', content: 'You are Mistral Vibe...', message_id: 's1' },
  { role: 'user', content: 'Reply with exactly: PONG', message_id: 'u1' },
  {
    role: 'assistant',
    content: 'PONG',
    reasoning_content: 'The user asked me to reply with PONG.',
    tool_calls: null,
    message_id: 'a1',
  },
]);

describe('vibeCliConfig', () => {
  it('is registered with the cli/vibe model patterns and buffer-at-end output', () => {
    expect(vibeCliConfig.name).toBe('Mistral Vibe');
    expect(vibeCliConfig.binaryPath).toBe('vibe');
    expect(vibeCliConfig.modelPatterns).toContain('cli/vibe');
    expect(vibeCliConfig.bufferOutput).toBe(true);
    expect(vibeCliConfig.quotaProvider).toBe('mistral-vibe');
  });

  it('buildArgs runs programmatic mode with json + trust + auto-approve', () => {
    const args = vibeCliConfig.buildArgs('hello');
    expect(args.slice(0, 2)).toEqual(['-p', 'hello']);
    expect(args).toContain('--output');
    expect(args).toContain('json');
    expect(args).toContain('--trust');
    expect(args).toContain('--auto-approve');
  });

  it('parseOutput extracts the last assistant message content from the JSON array', () => {
    const r = vibeCliConfig.parseOutput(VIBE_JSON_FIXTURE, Date.now() - 10);
    expect(r.content).toBe('PONG');
    expect(r.model).toBe('cli/vibe');
    // vibe reports no usage — must be zeroed (budget enforced via CLI caps).
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('picks the LAST assistant message when several are present', () => {
    const multi = JSON.stringify([
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'second' },
    ]);
    expect(vibeCliConfig.parseOutput(multi, Date.now()).content).toBe('second');
  });

  it('falls back to raw trimmed text when stdout is not JSON', () => {
    const r = vibeCliConfig.parseOutput('  just plain text  ', Date.now());
    expect(r.content).toBe('just plain text');
  });

  it('falls back to raw text when the array has no assistant message', () => {
    const noAssistant = JSON.stringify([{ role: 'user', content: 'hi' }]);
    expect(vibeCliConfig.parseOutput(noAssistant, Date.now()).content).toBe(noAssistant);
  });

  it('detects quota / rate-limit errors', () => {
    expect(vibeCliConfig.isQuotaError('429 rate limit exceeded')).toBe(true);
    expect(vibeCliConfig.isQuotaError('insufficient quota')).toBe(true);
    expect(vibeCliConfig.isQuotaError('all good')).toBe(false);
  });
});
