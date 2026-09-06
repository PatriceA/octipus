import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'general',
  // `shell` is here because `general` is what the ROOT agent runs since Phase 9
  // deleted the routing hop. Before that, "run this command" was delegated to
  // `coding`/`devops`, which carry it; afterwards the root answered "no
  // shell/terminal tool is mounted in this session" — true of the role, and
  // wrong about the product. Execution is still gated by the shell tool's own
  // permission + sandbox, which is where that decision belongs.
  toolIds: ['filesystem', 'shell', 'browser-ext', 'websearch', 'messaging', 'knowledge', 'notes', 'tasks', 'task_state', 'scheduling', 'profiles', 'email-processor', 'artifacts', 'artifacts_toolbox', 'documents', 'skill-distill', 'mcp'],
  // Lazy tool discovery (Ollama, non-small only): general is a catch-all with the
  // biggest payload (~53k). Core covers the prompt's explicitly-routed everyday
  // intents (filesystem, websearch, knowledge, messaging, notes, tasks); the
  // heavy/occasional tools — artifacts (~12k), browser-ext (~11k), scheduling,
  // profiles, email-processor, artifacts_toolbox, task_state — become the long
  // tail via list_tools/describe_tool. No effect on remote providers/small
  // models. See docs/OLLAMA.md.
  // `shell` must be CORE, not long tail: asked to run a command with shell in
  // the tail, the model did not call `list_tools` — it asserted the tool did
  // not exist and stopped. A capability the user names directly cannot depend
  // on the model choosing to go looking for it.
  coreToolIds: ['filesystem', 'shell', 'websearch', 'knowledge', 'messaging', 'notes', 'tasks'],
  defaultTopic: 'general',
};
