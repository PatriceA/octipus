import { createHash } from 'node:crypto';
import { queryRaw } from '../postgres';
import { redactCredentialData } from '@/security/credential-redaction';

// Administrative remediation only, never a model-facing vault consumer. The
// scope and identifiers are server-owned SQL; plaintext is compared in memory,
// never used as a WHERE parameter, log field, report value or backup copy.
const SOURCES: Record<string, string> = {
  pipelines: 't.user_id::text=$1',
  run_events: 'EXISTS (SELECT 1 FROM sessions p WHERE p.id=t.run_id AND p.user_id::text=$1)',
  sessions: 't.user_id::text=$1',
  messages: 'EXISTS (SELECT 1 FROM sessions p WHERE p.id=t.session_id AND p.user_id::text=$1)',
  plan_items: 'EXISTS (SELECT 1 FROM pipelines p WHERE p.id=t.pipeline_id AND p.user_id::text=$1)',
  pipeline_nodes: 'EXISTS (SELECT 1 FROM pipelines p WHERE p.id=t.pipeline_id AND p.user_id::text=$1)',
  pipeline_checkpoints: 'EXISTS (SELECT 1 FROM pipelines p WHERE p.id=t.pipeline_id AND p.user_id::text=$1)',
  agent_approvals: 't.user_id::text=$1', notifications: 't.user_id::text=$1',
  agents: 't.user_id::text=$1', agent_events: 't.user_id::text=$1',
  swarm_nodes: 't.user_id::text=$1',
  background_jobs: 't.user_id::text=$1',
  note_edit_proposals: 't.user_id::text=$1',
  embeddings: 't.user_id::text=$1',
  documents: 't.user_id::text=$1',
  memories: 't.user_id::text=$1',
  context_turns: 't.user_id::text=$1',
  trajectory_runs: 't.user_id::text=$1',
  tool_actions: 't.user_id::text=$1',
  monitors: 't.user_id::text=$1',
  task_state: 't.user_id::text=$1',
  permission_requests: 't.user_id::text=$1',
  skill_proposals: 't.user_id::text=$1',
  audit_log: 't.user_id::text=$1', notes: 't.user_id::text=$1',
  note_revisions: 'EXISTS (SELECT 1 FROM notes p WHERE p.id=t.note_id AND p.user_id::text=$1)',
  artifacts: 't.created_by_user_id::text=$1',
  artifact_data_snapshots: 'EXISTS (SELECT 1 FROM artifact_data_sources s JOIN artifacts p ON p.id=s.artifact_id WHERE s.id=t.source_id AND p.created_by_user_id::text=$1)',
  artifact_versions: 'EXISTS (SELECT 1 FROM artifacts p WHERE p.id=t.artifact_id AND p.created_by_user_id::text=$1)',
  artifact_data_sources: 'EXISTS (SELECT 1 FROM artifacts p WHERE p.id=t.artifact_id AND p.created_by_user_id::text=$1)',
  artifact_exports: 'EXISTS (SELECT 1 FROM artifacts p WHERE p.id=t.artifact_id AND p.created_by_user_id::text=$1)',
  artifact_widgets: 'EXISTS (SELECT 1 FROM artifacts p WHERE p.id=t.artifact_id AND p.created_by_user_id::text=$1)',
  artifact_transforms: 'EXISTS (SELECT 1 FROM artifacts p WHERE p.id=t.artifact_id AND p.created_by_user_id::text=$1)',
  artifact_share_links: 'EXISTS (SELECT 1 FROM artifacts p WHERE p.id=t.artifact_id AND p.created_by_user_id::text=$1)',
};

export interface CredentialRemediationResult {
  scanned: Record<string, number>;
  records: Array<{ table: string; id: string; columns: string[]; applied: boolean }>;
}

/** CAS updates preserve concurrent edits. Call again on a conflict; never
 * restore an old plan/status merely to remove a leaked credential. This does
 * not erase WAL, backups, external logs or caches held by running workers.
 */
export async function redactCredentialRecords(owner: string, values: string[], apply = false): Promise<CredentialRemediationResult> {
  if (!owner || !values.length || values.some(value => value.length < 8)) throw new Error('Invalid credential remediation scope');
  const result: CredentialRemediationResult = { scanned: {}, records: [] };
  for (const [table, scope] of Object.entries(SOURCES)) {
    const key = ['pipeline_checkpoints','run_events'].includes(table) ? 'seq' : 'id';
    const { rows: columns } = await queryRaw(`SELECT column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`, [table]);
    const contentColumns = columns.filter(column => column.column_name !== key && ['text','character varying','jsonb','json'].includes(column.data_type) && /^[a-z_][a-z0-9_]*$/.test(column.column_name));
    let count = 0;
    let cursor: string | null = null;
    for (;;) {
      const hashes = contentColumns.map(column => `md5(t."${column.column_name}"::text) AS "digest_${column.column_name}"`).join(',');
      const { rows } = await queryRaw(`SELECT t.*${hashes ? `,${hashes}` : ''} FROM "${table}" t WHERE ${scope} AND ($2::text IS NULL OR t."${key}"::text > $2::text) ORDER BY t."${key}"::text LIMIT 500`, [owner, cursor]);
      for (const row of rows) {
        const changes = contentColumns.flatMap(column => {
          const original = row[column.column_name];
          const redacted = redactCredentialData(original, values);
          if (table === 'sessions' && column.column_name === 'metadata'
            && JSON.stringify(original) !== JSON.stringify(redacted)) {
            const plan = (redacted as { workPlan?: { revision?: number; current?: { revision: number; updatedAt: string; history: unknown[] } } } | null)?.workPlan;
            if (plan && typeof plan.revision === 'number') {
              plan.revision += 1;
              if (plan.current) {
                plan.current.revision = plan.revision;
                plan.current.updatedAt = new Date().toISOString();
                plan.current.history = [...(plan.current.history ?? []), { revision: plan.revision, summary: 'Credential exposure redacted', at: plan.current.updatedAt }].slice(-100);
              }
            }
          }
          return JSON.stringify(original) === JSON.stringify(redacted) ? [] : [{ column: column.column_name, type: column.data_type, value: redacted }];
        });
        if (!changes.length) continue;
        const body = changes.find(change => change.column === 'body');
        if (body && ['notes', 'note_revisions'].includes(table)) changes.push({
          column: 'body_sha256', type: 'text', value: createHash('sha256').update(String(body.value)).digest('hex'),
        });
        let applied = false;
        if (apply) {
          const params: unknown[] = [owner, row[key]];
          const assignments = table === 'embeddings' ? [] : changes.map(change => {
            params.push(change.type.startsWith('json') ? JSON.stringify(change.value) : change.value);
            return `"${change.column}"=$${params.length}${change.type.startsWith('json') ? `::${change.type}` : ''}`;
          });
          const checks = changes.map(change => {
            params.push(row[`digest_${change.column}`]);
            return `md5(t."${change.column}"::text)=$${params.length}`;
          });
          if (columns.some(column => column.column_name === 'updated_at')) assignments.push('updated_at=now()');
          const statement = table === 'embeddings' ? `DELETE FROM "${table}" t` : `UPDATE "${table}" t SET ${assignments.join(',')}`;
          const updated = await queryRaw(`${statement}
            WHERE ${scope} AND t."${key}"=$2 AND ${checks.join(' AND ')} RETURNING t."${key}"`, params);
          if (updated.rows.length && table === 'notes' && body) await queryRaw(
            "DELETE FROM embeddings WHERE user_id::text=$1 AND purpose='note' AND source_id=$2", [owner, `note:${row[key]}`]);
          applied = updated.rows.length === 1;
        }
        result.records.push({ table, id: String(row[key]), columns: changes.map(change => change.column), applied });
      }
      count += rows.length;
      cursor = rows.length ? String(rows.at(-1)[key]) : cursor;
      if (rows.length < 500) break;
    }
    result.scanned[table] = count;
  }
  return result;
}
