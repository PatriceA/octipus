import { describe, expect, test } from 'vitest';
import { createMetaTools } from './meta-tools';

/**
 * Behavioral tests for the persona-related meta-tools
 * (`remember_about_self`, `reflect`). Pure shape + argument-validation
 * checks. DB-touching paths live in integration tests.
 */

function tool(name: string) {
  // No parentNode → swarm spawn_child is skipped, but the rest are
  // registered. Cast the service argument since these tools don't
  // touch the service when called.
  const orchestrator = {} as unknown as Parameters<typeof createMetaTools>[0];
  return createMetaTools(orchestrator).find(t => t.name === name);
}

describe('remember_about_self meta-tool', () => {
  test('is registered with a description that names the persona system', () => {
    const t = tool('remember_about_self');
    expect(t).toBeDefined();
    expect(t!.description).toMatch(/persona/i);
    expect(t!.description).toMatch(/yourself/i);
    expect(t!.parameters).toMatchObject({
      type: 'object',
      properties: { fact: { type: 'string' } },
      required: ['fact'],
    });
  });

  test('rejects too-short facts before any DB call', async () => {
    const t = tool('remember_about_self');
    const result = await t!.execute({ fact: 'no' }, {
      userId: 'user-1',
      sessionId: 'session-1',
      metadata: {},
    } as never) as { stored: boolean; reason?: string };
    expect(result.stored).toBe(false);
    expect(result.reason).toMatch(/too short/);
  });

  test('rejects too-long facts before any DB call', async () => {
    const t = tool('remember_about_self');
    const result = await t!.execute({ fact: 'x'.repeat(400) }, {
      userId: 'user-1',
      sessionId: 'session-1',
      metadata: {},
    } as never) as { stored: boolean; reason?: string };
    expect(result.stored).toBe(false);
    expect(result.reason).toMatch(/too long/);
  });
});

describe('reflect meta-tool', () => {
  test('is registered with a no-spawn description', () => {
    const t = tool('reflect');
    expect(t).toBeDefined();
    expect(t!.description).toMatch(/without spawning/i);
    expect(t!.description).toMatch(/swarm tree/i);
  });

  test('takes no arguments', () => {
    const t = tool('reflect');
    expect(t!.parameters).toMatchObject({ type: 'object', properties: {} });
  });
});
