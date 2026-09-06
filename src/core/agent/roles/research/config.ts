import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'research',
  // browser + browser-ext (Playwright) dropped: their JSON schemas dominated the
  // per-request tool payload (thousands of tokens each, sent every turn) and a
  // researcher gets live web content via websearch's fetch_page. Re-add only if
  // JS-heavy scraping becomes a real need.
  toolIds: ['websearch', 'knowledge', 'task_state', 'filesystem', 'profiles', 'artifacts', 'artifacts_toolbox', 'documents', 'repo_registry', 'skill-distill', 'mcp'],
  // Lazy tool discovery (Ollama, non-small only): a research turn almost always
  // needs websearch + knowledge; the rest (filesystem, profiles, artifacts,
  // artifacts_toolbox, task_state) is the long tail reached via list_tools /
  // describe_tool. mcp stays core automatically (it's its own discovery surface).
  // No effect on remote providers or small models. See docs/OLLAMA.md.
  coreToolIds: ['websearch', 'knowledge'],
  defaultTopic: 'research',
};
