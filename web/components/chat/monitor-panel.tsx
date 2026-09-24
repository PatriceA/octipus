import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Monitor = {
  id: string; name: string; status: string; source: { kind: string }; deadline: string;
  lastCheckedAt: string | null; nextCheckAt: string; lastError: string | null;
};
const labels: Record<string, string> = { armed: 'Waiting', paused: 'Paused', ready: 'Ready to continue', delivering: 'Continuing', completed: 'Finished', cancelled: 'Cancelled', blocked: 'Needs review' };
export default function MonitorPanel({ sessionId }: { sessionId: string | null }) {
  const [rows, setRows] = useState<Monitor[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await api.get<{ monitors: Monitor[] }>(`/sessions/${sessionId}/monitors`);
        if (!disposed) { setRows(Array.isArray(result?.monitors) ? result.monitors : []); setError(''); }
      } catch (err) { if (!disposed) setError(err instanceof Error ? err.message : 'Could not load monitors'); }
      finally { if (!disposed) timer = setTimeout(read, 5000); }
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [sessionId, refresh]);
  async function control(id: string, action: string) {
    setPending(id);
    try {
      await api.post(`/sessions/${sessionId}/monitors/${id}/control`, { action });
      setRefresh(n => n + 1);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update monitor'); }
    finally { setPending(null); }
  }
  if (!sessionId || (!rows.length && !error)) return null;
  const active = rows.filter(row => !['completed', 'cancelled'].includes(row.status));
  const visible = [...active, ...rows.filter(row => ['completed', 'cancelled'].includes(row.status)).slice(-3)];
  return <section className="border-b border-outline-variant/50 p-4 space-y-3" aria-label="Session monitors">
    <h2 className="text-sm font-semibold">Monitors{active.length ? ` · ${active.length} active` : ''}</h2>
    {error && <p role="alert" className="text-xs text-warning">{error}</p>}
    {visible.map(row => <div key={row.id} className="space-y-1 text-xs">
      <div className="font-medium">{row.name}</div>
      <div className="text-on-surface-variant">{labels[row.status] ?? row.status} · {row.source.kind}</div>
      {row.lastCheckedAt && <div>Last checked {new Date(row.lastCheckedAt).toLocaleTimeString()}</div>}
      {row.status === 'armed' && <div>Next check {new Date(row.nextCheckAt).toLocaleTimeString()} · Deadline {new Date(row.deadline).toLocaleTimeString()}</div>}
      {row.lastError && <p className="text-warning">{row.lastError}</p>}
      <div className="flex gap-3">
        {row.status === 'armed' && <button disabled={pending === row.id} className="underline" onClick={() => void control(row.id, 'pause')}>Pause</button>}
        {row.status === 'paused' && <button disabled={pending === row.id} className="underline" onClick={() => void control(row.id, 'resume')}>Resume</button>}
        {['armed', 'paused', 'ready', 'blocked'].includes(row.status) && <button disabled={pending === row.id} className="underline" onClick={() => void control(row.id, 'cancel')}>Cancel</button>}
      </div>
    </div>)}
  </section>;
}
