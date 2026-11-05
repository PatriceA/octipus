'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { permissionProfileDisclosure, proposedPipelinePermissionProfileSchema, type PipelinePermissionProfile } from '../../src/shared/pipeline-permissions';

export function PipelinePermissions({ id, status, stored, onSaved }: {
  id: string;
  status: string;
  stored?: { profile?: Partial<PipelinePermissionProfile> };
  onSaved: () => void;
}) {
  const current = stored?.profile;
  const [repositories, setRepositories] = useState([current?.repoPath, ...(current?.repoPaths ?? [])].filter(Boolean).join('\n'));
  const [hostServices, setHostServices] = useState(current?.hostServices === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const editable = ['paused', 'stopped', 'failed'].includes(status);
  const run = current?.executionScope === 'run';
  const disclosure = permissionProfileDisclosure(proposedPipelinePermissionProfileSchema.parse({ repoPath: '/selected-repositories' }));

  const save = async (executionScope: 'run' | 'commands') => {
    setSaving(true); setError(''); setSaved(false);
    try {
      const paths = repositories.split('\n').map(path => path.trim()).filter(Boolean);
      if (!paths.length || paths.some(path => !path.startsWith('/') && !/^[a-z]:[\\/]/i.test(path))) throw new Error('Enter an absolute repository path on each line.');
      const profile = proposedPipelinePermissionProfileSchema.parse({ ...current, executionScope,
        repoPath: paths[0], repoPaths: paths.slice(1), hostServices,
        // Revocation must not leave an implicit command-family authorization.
        commands: [], packageManagers: [], publicHosts: [], dockerProjects: [],
      });
      const result = await api.put<{ saved?: boolean; error?: string }>(`/pipelines/${id}/permission-profile`, { profile, confirmed: true });
      if (!result.saved || result.error) throw new Error(result.error ?? 'Permissions could not be saved');
      setSaved(true); onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Permissions could not be saved'); }
    finally { setSaving(false); }
  };

  return <section aria-label="Run permissions" className="mt-4 border-t border-outline-variant/20 pt-4 space-y-3 text-sm">
    <h3 className="font-medium">Run permissions</h3>
    <p>Current shell approval: {run ? 'Entire run' : 'Individual commands'}</p>
    <label className="block">Repositories (one absolute path per line)
      <textarea aria-label="Approved repositories" value={repositories} onChange={event => setRepositories(event.target.value)} disabled={!editable || saving}
        className="mt-1 block w-full rounded border border-outline-variant/30 bg-surface p-2" rows={2} />
    </label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={hostServices} onChange={event => setHostServices(event.target.checked)} disabled={!editable || saving} />Allow host services and Docker socket</label>
    <p className="text-on-surface-variant">{disclosure}</p>
    {!editable && <p>Pause the pipeline before changing its permissions.</p>}
    <div className="flex gap-3">
      <button type="button" onClick={() => save('run')} disabled={!editable || saving} className="rounded-full bg-primary text-on-primary px-3 py-2 disabled:opacity-50">{saving ? 'Saving…' : 'Approve entire run'}</button>
      {run && <button type="button" onClick={() => save('commands')} disabled={!editable || saving} className="rounded-full border border-outline-variant/30 px-3 py-2 disabled:opacity-50">Revoke run-wide shell approval</button>}
    </div>
    {error && <p role="alert" className="text-error">{error}</p>}
    {saved && <p role="status">Permissions saved. Resume the pipeline when ready.</p>}
  </section>;
}
