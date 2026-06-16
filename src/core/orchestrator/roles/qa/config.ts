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
};
