import { describe, expect, test } from 'vitest';
import type { CompletionOptions } from '../litellm-client';
import { AnthropicProvider } from './anthropic-provider';
import { markHistoryCacheBreakpoint, markToolsCacheBreakpoint } from './custom/anthropic-compat-provider';
import { supportsNativeToolSearch, TOOL_SEARCH_TOOL, withToolSearch } from './tool-search';

const buildBody = (o: CompletionOptions) =>
  (new AnthropicProvider() as unknown as { buildNativeBody(o: CompletionOptions, s: boolean): Record<string, unknown> })
    .buildNativeBody(o, false);

const fn = (name: string) => ({ type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } } });

describe('which models have tool search', () => {
  test.each([
    ['claude-opus-5-5', true], ['claude-sonnet-5-5', true], ['claude-haiku-5-5', true], ['claude-fable-5-1', true],
    ['claude-opus-4-8', true], ['claude-sonnet-4-6', true], ['claude-haiku-4-5-20251001', true], ['anthropic/claude-opus-5', true],
    ['claude-opus-4-1', false], ['claude-3-5-sonnet-20241022', false], ['gpt-5.6', false],
  ])('%s → %s', (model, expected) => {
    expect(supportsNativeToolSearch(model)).toBe(expected);
  });
});

describe('the request with tool search', () => {
  const opts: CompletionOptions = {
    model: 'claude-opus-5-5', maxTokens: 1000, cacheScope: 'root:g', cachePacing: 'human',
    messages: [{ role: 'user', content: 'hi' }] as CompletionOptions['messages'],
    tools: [fn('filesystem__read_file'), fn('notes__search'), fn('websearch__search')],
    deferredTools: ['notes__search', 'websearch__search'],
  };

  test('every tool is sent, the long tail deferred, the search tool first and never deferred', () => {
    const tools = buildBody(opts).tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject(TOOL_SEARCH_TOOL);
    expect(tools[0]).not.toHaveProperty('defer_loading');
    expect(tools.map((t) => t.name)).toEqual(['tool_search_tool_bm25', 'filesystem__read_file', 'notes__search', 'websearch__search']);
    expect(tools.filter((t) => t.defer_loading).map((t) => t.name)).toEqual(['notes__search', 'websearch__search']);
  });

  test('the tools breakpoint sits on the last loaded client tool, never on a deferred one (that is a 400)', () => {
    const tools = buildBody(opts).tools as Array<Record<string, unknown>>;
    expect(tools.filter((t) => t.cache_control).map((t) => t.name)).toEqual(['filesystem__read_file']);
  });

  test('without deferrals the request is unchanged', () => {
    const tools = buildBody({ ...opts, deferredTools: undefined }).tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.name)).toEqual(['filesystem__read_file', 'notes__search', 'websearch__search']);
    expect(tools.at(-1)).toHaveProperty('cache_control');
  });

  test('withToolSearch does not mutate what it was given', () => {
    const given = [{ name: 'a', input_schema: {} }];
    withToolSearch(given, new Set(['a']));
    expect(given[0]).not.toHaveProperty('defer_loading');
  });

  test('a tool list of only deferred tools and the server tool gets no tools breakpoint', () => {
    const tools = [{ ...TOOL_SEARCH_TOOL }, { name: 'a', input_schema: {}, defer_loading: true }];
    expect(markToolsCacheBreakpoint(tools)).toBe(false);
  });

  test('the history breakpoint skips the replayed search blocks', () => {
    const messages = [{
      role: 'assistant' as const,
      content: [
        { type: 'text', text: 'looking' },
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'notes' } },
        { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [] } },
      ],
    }, { role: 'user' as const, content: [{ type: 'text', text: 'next' }] }];
    markHistoryCacheBreakpoint(messages as never, false);
    const blocks = messages[0].content as Array<Record<string, unknown>>;
    expect(blocks.filter((b) => b.cache_control).map((b) => b.type)).toEqual(['text']);
  });
});
