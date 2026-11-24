import { describe, expect, test } from 'vitest';
import { EMAIL_TURN_CONTEXT, emailTurnContext, emailTurnTools } from './email-context';

const handler = (name: string) => ({ name, toolId: name.split('__')[0] });
const registry = {
  getToolHandlersForTools: (ids: string[]) => [
    'websearch__search', 'websearch__fetch', 'knowledge__search_product_docs', 'knowledge__read_product_doc',
    'knowledge__search_knowledge', 'knowledge__index_file', 'shell__execute', 'mcp__crm__lookup',
  ].map(handler).filter((h) => ids.includes(h.toolId)),
};

describe('an email turn', () => {
  test('gets the web search and the bundled help only: no page fetch, no knowledge base, no shell, no MCP', () => {
    expect(emailTurnTools(registry, 'anthropic').map((t) => t.name)).toEqual([
      'websearch__search', 'knowledge__search_product_docs', 'knowledge__read_product_doc',
    ]);
  });

  test('cannot run on a CLI agent, which brings its own tools', () => {
    expect(() => emailTurnTools(registry, 'cli')).toThrow(/API or local model/);
  });

  test('carries the email notice; other channels do not', () => {
    expect(emailTurnContext('email')).toBe(EMAIL_TURN_CONTEXT);
    expect(emailTurnContext('slack')).toBe('');
  });
});
