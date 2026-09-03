import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'review',
  toolIds: ['filesystem', 'shell', 'git', 'github', 'knowledge', 'task_state', 'repo_registry', 'visual'],
  // Not opted into lazy tool discovery: review's tools are nearly all hot-path
  // (filesystem/shell/git/github read code+diffs every turn, and the prompt
  // mandates search_knowledge as step 1), so only visual/task_state (~1.5k of
  // 27k) could move to the long tail — not worth a discovery round-trip.
  coreToolIds: ['filesystem', 'git', 'shell'],
  defaultTopic: 'review',
  // `prompt.md` has said "You are READ-ONLY — do NOT modify code" and "No
  // `write_file`, no edits" since it was written. This makes that true instead
  // of merely stated: the write handlers are removed from the surface entirely.
  // Review is the only role where this is a tightening rather than a change of
  // job — architecture/qa/research are all specified to produce files.
  // Partial by construction: review keeps `shell`, so `echo > file` still
  // works. Closing that means taking shell away, which would cost review the
  // ability to run the checks it reviews against.
  readOnly: true,
};
