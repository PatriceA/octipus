import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'qa',
  toolIds: ['browser', 'browser-ext', 'shell', 'docker', 'filesystem', 'knowledge', 'task_state', 'visual', 'artifacts', 'artifacts_toolbox'],
  // Lazy tool discovery (Ollama, non-small only): the common QA path is test-suite
  // work (shell + filesystem + task_state). artifacts (~12k, the artifact-
  // validation path — a multi-call flow that amortizes one discovery round-trip)
  // + browser/browser-ext (~16k) + docker + knowledge + visual become the long
  // tail. No effect on remote providers/small models, or machines without those
  // tools installed (capability gating already drops them). See docs/OLLAMA.md.
  coreToolIds: ['shell', 'filesystem', 'task_state'],
  defaultTopic: 'qa',
  // Read-only: the file-mutating filesystem handlers are stripped from this
  // role's surface (see RoleMeta.readOnly). Its deliverable is returned in the
  // reply and handed to `coding` to persist — the prompt's OUTPUT section was
  // rewritten to match, since writing used to BE this role's deliverable.
  // Partial by construction: this role keeps `shell`, so `echo > file` remains
  // possible. Defense-in-depth, not a boundary.
  readOnly: true,
};
