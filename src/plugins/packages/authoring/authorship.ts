/**
 * Who wrote a package: a person, or an agent in creator mode
 * (docs/PLUGIN-PACKAGES.md#writing-a-plugin-with-an-agent). Read from the
 * audit row of the package's latest install or upgrade, so it needs no column:
 * `plugin_install` passes `authoredBy` to `installFromDirectory`, which writes
 * it into that row's details. A later install or upgrade by a person makes the
 * package theirs again.
 */
import { auditRepository } from '@/db/repositories/audit-repository';
import type { PluginAgentAuthorship } from '@/shared/plugin-package';

/** What an agent install records in its audit row's details, under `authoredBy`. */
export interface AgentAuthoredDetails {
  kind: 'agent';
  /** The user the agent worked for (who approved the install). */
  userId: string;
  sessionId: string | null;
  agentId: string | null;
}

function isAgentAuthored(value: unknown): value is AgentAuthoredDetails {
  const v = value as Partial<AgentAuthoredDetails> | null;
  return typeof v === 'object' && v !== null && v.kind === 'agent' && typeof v.userId === 'string';
}

/** The agent that installed the current version of each named package (absent: a person did). */
export async function agentAuthorships(names: readonly string[]): Promise<Map<string, PluginAgentAuthorship>> {
  const out = new Map<string, PluginAgentAuthorship>();
  if (names.length === 0) return out;
  const rows = await auditRepository.findPluginInstalls(names);
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.name === null || seen.has(row.name)) continue;
    seen.add(row.name);
    const by = (row.details as Record<string, unknown> | null)?.authoredBy;
    if (!isAgentAuthored(by)) continue;
    out.set(row.name, { userId: by.userId, sessionId: by.sessionId ?? null, agentId: by.agentId ?? null, at: row.createdAt.toISOString() });
  }
  return out;
}

/** The agent that installed the current version of `name`, or null. */
export async function agentAuthorship(name: string): Promise<PluginAgentAuthorship | null> {
  return (await agentAuthorships([name])).get(name) ?? null;
}
