'use client';

import { useState } from 'react';
import type { PluginCompanionDecl } from '../../../src/shared/plugin-package';
import { api } from '@/lib/api';

/** Descriptive only: downloaded services are installed by the administrator. */
export function CompanionServices({ companions = [], plugin }: { companions?: PluginCompanionDecl[]; plugin?: string }) {
  const [error, setError] = useState('');
  if (!companions.length) return null;
  async function download(c: PluginCompanionDecl, file: 'bundle' | 'guide') {
    setError('');
    try {
      const blob = await api.getBlob('/plugin-packages/' + encodeURIComponent(plugin!) + '/companions/' + encodeURIComponent(c.id) + '/' + file);
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = (file === 'bundle' ? c.bundle : c.guide).split('/').pop()!;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError((e as Error).message); }
  }
  return <section className="mt-3 space-y-3 rounded-md border border-outline-variant p-3" data-testid="companion-services">
    <h3 className="text-sm font-semibold text-on-surface">Companion services</h3>
    <p className="text-xs text-on-surface-variant">Included in the package. Install separately on the stated machine. Octipus does not start, update or remove these services.</p>
    {companions.map(c => <article key={c.id} className="space-y-2 text-xs">
      <h4 className="font-semibold text-on-surface">{c.title} · {c.optional ? 'Optional' : 'Required for the described feature'}</h4>
      <p>{c.description}</p>
      <dl className="space-y-1 text-on-surface-variant">
        <div><dt className="inline font-medium">Runs on: </dt><dd className="inline">{c.runsOn}</dd></div>
        <div><dt className="inline font-medium">Platforms: </dt><dd className="inline">{c.platforms.join(', ')}</dd></div>
        <div><dt className="inline font-medium">Requirements: </dt><dd className="inline">{c.requirements.join('; ')}</dd></div>
        <div><dt className="inline font-medium">Reads: </dt><dd className="inline">{c.dataAccess.join('; ')}</dd></div>
        <div><dt className="inline font-medium">Permissions: </dt><dd className="inline">{c.privileges}</dd></div>
      </dl>
      {plugin ? <div className="flex flex-wrap gap-3">
        <button type="button" className="underline" onClick={() => void download(c, 'bundle')}>Download {c.title} bundle</button>
        <button type="button" className="underline" onClick={() => void download(c, 'guide')}>Download setup guide</button>
      </div> : <p className="text-on-surface-variant">Bundle and setup guide available under Admin → Plugins after installation.</p>}
    </article>)}
    {error && <p role="alert" className="text-error">{error}</p>}
  </section>;
}
