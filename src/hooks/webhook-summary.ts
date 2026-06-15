/**
 * Concise, human-readable summary of a webhook payload for the agent prompt /
 * user-visible message.
 *
 * Previously the whole payload was `JSON.stringify`'d into the message, which
 * dumped hundreds of lines of GitHub repo metadata into the chat the user sees.
 * GitHub & GitLab push events are summarized to the signal a reviewer actually
 * needs — repo, branch, pusher, and per-commit subject + changed files — and
 * anything unrecognized falls back to a one-line field list rather than the
 * full tree.
 */

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

const MAX_COMMITS = 20;
const MAX_FILES = 50;

export function summarizeWebhookPayload(body: unknown): string {
  const p = obj(body);
  if (!p) return 'Webhook received (no structured payload).';

  const repository = obj(p.repository);
  // GitHub / GitLab push event shape: { ref, commits[], repository }
  if (typeof p.ref === 'string' && Array.isArray(p.commits) && repository) {
    const repo = (repository.full_name as string) || (repository.name as string) || 'unknown repo';
    const branch = p.ref.replace(/^refs\/heads\//, '');
    const pusher =
      (obj(p.pusher)?.name as string) || (obj(p.sender)?.login as string) || 'someone';
    const commits = p.commits as unknown[];
    const lines = [
      `GitHub push to ${repo} (branch \`${branch}\`) by ${pusher} — ${commits.length} commit${commits.length === 1 ? '' : 's'}.`,
    ];

    for (const raw of commits.slice(0, MAX_COMMITS)) {
      const c = obj(raw);
      if (!c) continue;
      const sha = String(c.id ?? '').slice(0, 9);
      const subject = String(c.message ?? '').split('\n')[0];
      lines.push(`\n• ${sha} ${subject}`);
      const changed = [
        ...asStringArray(c.added).map((f) => `+${f}`),
        ...asStringArray(c.modified).map((f) => `~${f}`),
        ...asStringArray(c.removed).map((f) => `-${f}`),
      ];
      if (changed.length) {
        lines.push(`  files: ${changed.slice(0, MAX_FILES).join(', ')}${changed.length > MAX_FILES ? ', …' : ''}`);
      }
    }
    if (commits.length > MAX_COMMITS) lines.push(`\n…and ${commits.length - MAX_COMMITS} more commits.`);
    if (typeof p.compare === 'string') lines.push(`\nCompare: ${p.compare}`);
    return lines.join('');
  }

  const keys = Object.keys(p).slice(0, 12);
  return `Webhook payload received${keys.length ? ` with fields: ${keys.join(', ')}` : ''}.`;
}
