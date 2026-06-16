import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'security',
  toolIds: ['shell', 'filesystem', 'browser', 'browser-ext', 'websearch', 'knowledge', 'task_state', 'mcp'],
  // Lazy tool discovery (Ollama, non-small only): hot path is shell + filesystem
  // + websearch + knowledge (the prompt mandates search_knowledge as step 1).
  // browser/browser-ext (~16k of schema) + task_state become the long tail via
  // list_tools/describe_tool. No effect on remote providers/small models, or
  // machines without browser tools installed. See docs/OLLAMA.md.
  coreToolIds: ['shell', 'filesystem', 'websearch', 'knowledge'],
  defaultTopic: 'security',
};
