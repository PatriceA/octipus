import { describe, expect, test, vi } from 'vitest';
import type { ToolHandler } from '@/core/agent-base';
import { buildCapabilitiesHandler } from './self-report';

/**
 * The agent has to be able to describe itself.
 *
 * Asked "what can you do?", an agent with no way to enumerate its own surface
 * answers from whatever happens to be in its advertised schema — which on the
 * lazy path is a fraction of what it can call, and which says nothing at all
 * about MCP servers, skills, experts or recipes. This tool is the answer, so
 * the things worth pinning are: it reports BOTH numbers when they differ, and
 * one dead subsystem does not take the whole report down with it.
 */

const ctx = (over: Partial<Parameters<typeof buildCapabilitiesHandler>[0]> = {}) => ({
  advertised: [] as ToolHandler[],
  registered: [] as ToolHandler[],
  model: 'test-model',
  role: 'general',
  ...over,
});

const handler = (name: string, toolId?: string): ToolHandler => ({
  name,
  description: name,
  parameters: {},
  toolId,
  execute: async () => null,
});

/** No DB and no MCP bridge in this suite — every remote section is expected to
 *  degrade, which is exactly the behaviour under test. */
const run = (h: ToolHandler, args: Record<string, unknown> = {}) =>
  h.execute(args, {} as never) as Promise<Record<string, unknown>>;

describe('reporting the tool surface', () => {
  test('advertised and callable are reported separately', async () => {
    const registered = [handler('read_file', 'filesystem'), handler('run', 'shell')];
    const h = buildCapabilitiesHandler(ctx({ advertised: [registered[0] as ToolHandler], registered }));

    const out = await run(h, { section: 'tools' });
    expect(out.tools).toMatchObject({ advertised: 1, callable: 2 });
  });

  test('tools are grouped by the toolbox that registered them', async () => {
    const registered = [
      handler('read_file', 'filesystem'),
      handler('write_file', 'filesystem'),
      handler('run', 'shell'),
    ];
    const out = await run(buildCapabilitiesHandler(ctx({ registered })), { section: 'tools' });

    expect((out.tools as { byToolbox: Record<string, string[]> }).byToolbox).toEqual({
      filesystem: ['read_file', 'write_file'],
      shell: ['run'],
    });
  });

  test('a handler with no toolbox is still reported, not dropped', async () => {
    const out = await run(
      buildCapabilitiesHandler(ctx({ registered: [handler('spawn_child')] })),
      { section: 'tools' },
    );
    expect((out.tools as { byToolbox: Record<string, string[]> }).byToolbox).toEqual({
      ungrouped: ['spawn_child'],
    });
  });

  test('the model and role serving the turn are always named', async () => {
    const out = await run(buildCapabilitiesHandler(ctx()), { section: 'tools' });
    expect(out).toMatchObject({ model: 'test-model', role: 'general' });
  });
});

describe('asking for one part', () => {
  test('a section filter returns only that section', async () => {
    const out = await run(buildCapabilitiesHandler(ctx()), { section: 'tools' });
    expect(Object.keys(out).sort()).toEqual(['model', 'role', 'tools']);
  });

  test('an unknown section falls back to the whole report rather than erroring', async () => {
    const out = await run(buildCapabilitiesHandler(ctx()), { section: 'nonsense' });
    for (const key of ['tools', 'mcpServers', 'skills', 'experts', 'pipelines']) {
      expect(out).toHaveProperty(key);
    }
  });

  test('no section at all means everything', async () => {
    const out = await run(buildCapabilitiesHandler(ctx()));
    expect(out).toHaveProperty('mcpServers');
    expect(out).toHaveProperty('skills');
  });
});

describe('when a subsystem is down', () => {
  test('the section says so and the rest of the report still arrives', async () => {
    // Nothing is stubbed here: with no DB connection the skills/experts/pipeline
    // sections genuinely fail, which is the condition being asserted.
    const out = await run(buildCapabilitiesHandler(ctx({ registered: [handler('read_file', 'filesystem')] })));

    expect(out.tools).toMatchObject({ callable: 1 });
    for (const key of ['skills', 'experts', 'pipelines']) {
      const section = out[key] as { unavailable?: string };
      expect(
        section && (Array.isArray(section) || typeof section.unavailable === 'string'),
        `${key} should be data or an explanation, got ${JSON.stringify(section)}`,
      ).toBe(true);
    }
  });

  test('a throwing section never rejects the call', async () => {
    vi.resetModules();
    await expect(run(buildCapabilitiesHandler(ctx()), { section: 'mcp' })).resolves.toHaveProperty('mcpServers');
  });
});

describe('what it must not hand out', () => {
  test('no userId means no skills, not everyone\'s skills', async () => {
    // `skillRepository.findAll(undefined)` returns every user's rows unfiltered.
    // The experts and pipeline sections beside it already fail closed; this one
    // failed open, guarded only by every caller happening to pass a userId.
    const out = await run(buildCapabilitiesHandler(ctx({ userId: undefined })), { section: 'skills' });
    expect(out.skills).toEqual([]);
  });

  test('an empty userId is treated the same as none', async () => {
    const out = await run(buildCapabilitiesHandler(ctx({ userId: '' })), { section: 'skills' });
    expect(out.skills).toEqual([]);
  });

  test('a failing section reports a capped reason, not a raw driver error', async () => {
    // Driver errors carry connection strings; a tool result is the one place
    // they would be echoed straight back into a transcript.
    const out = await run(buildCapabilitiesHandler(ctx({ userId: 'u1' })), { section: 'experts' });
    const section = out.experts as { unavailable?: string } | unknown[];
    if (!Array.isArray(section) && section.unavailable !== undefined) {
      expect(section.unavailable.length).toBeLessThanOrEqual(120);
    }
  });
});
