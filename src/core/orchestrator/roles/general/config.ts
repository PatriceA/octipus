import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'general',
  toolIds: ['filesystem', 'browser-ext', 'websearch', 'messaging', 'knowledge', 'notes', 'tasks', 'task_state', 'scheduling', 'profiles', 'email-processor', 'artifacts', 'artifacts_toolbox', 'mcp'],
  // Lazy tool discovery (Ollama, non-small only): general is a catch-all with the
  // biggest payload (~53k). Core covers the prompt's explicitly-routed everyday
  // intents (filesystem, websearch, knowledge, messaging, notes, tasks); the
  // heavy/occasional tools — artifacts (~12k), browser-ext (~11k), scheduling,
  // profiles, email-processor, artifacts_toolbox, task_state — become the long
  // tail via list_tools/describe_tool. No effect on remote providers/small
  // models. See docs/OLLAMA.md.
  coreToolIds: ['filesystem', 'websearch', 'knowledge', 'messaging', 'notes', 'tasks'],
  defaultTopic: 'general',
};
