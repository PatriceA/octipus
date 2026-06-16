import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'research',
  // browser + browser-ext (Playwright) dropped: their JSON schemas dominated the
  // per-request tool payload (thousands of tokens each, sent every turn) and a
  // researcher gets live web content via websearch's fetch_page. Re-add only if
  // JS-heavy scraping becomes a real need.
  toolIds: ['websearch', 'knowledge', 'task_state', 'filesystem', 'profiles', 'artifacts', 'artifacts_toolbox', 'mcp'],
  defaultTopic: 'research',
};
