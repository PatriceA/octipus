/**
 * Chat/work split (`.octipus/end-user-ux-design.md` Thread 3): the system-prompt
 * fragment that tells the agent whether the turn's deliverable belongs inline in
 * the chat reply or in an editable file the user opens in the Files tab.
 *
 * `mode` is the effective mode (user's per-message toggle wins, else the
 * classifier heuristic); `forced` is whether the user set it explicitly.
 *
 * Returns '' for the common case (default inline, not forced) so existing
 * orchestrator behavior — including coding/devops tasks that legitimately write
 * files via their own tools — is completely unchanged.
 */
export function buildOutputDirective(mode: 'inline' | 'file', forced: boolean): string {
  if (mode === 'file') {
    return (
      '\n\nDELIVERABLE FORMAT — FILE: The user wants an editable file, not a wall of text in ' +
      'chat. Write the deliverable to a sensibly-named file in the workspace (use the filesystem ' +
      'write_file tool, or delegate to a specialist that does), then reply with a 1–2 sentence ' +
      'summary that names the file. Do NOT paste the full content into chat — the user opens it ' +
      'from the Files tab.'
    );
  }
  // Inline is the default; only emit an instruction when the user EXPLICITLY
  // forced it, so we can suppress file creation for an otherwise document-shaped
  // ask without disturbing normal task behavior.
  if (forced) {
    return (
      '\n\nDELIVERABLE FORMAT — INLINE: Answer directly in your chat reply. Do not create or write ' +
      'files for this request.'
    );
  }
  return '';
}
