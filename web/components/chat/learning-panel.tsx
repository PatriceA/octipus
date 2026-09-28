import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LearningCheckView } from '../../../src/shared/learning';
import { api } from '@/lib/api';

export default function LearningPanel({ sessionId }: { sessionId: string | null }) {
  const client = useQueryClient();
  const key = ['session-learning', sessionId];
  const query = useQuery({ queryKey: key, enabled: !!sessionId,
    queryFn: () => api.get<{ checks: LearningCheckView[] }>(`/sessions/${sessionId}/learning`), refetchInterval: 15_000 });
  const check = useMutation({ mutationFn: () => api.post(`/sessions/${sessionId}/learning`, {}),
    onSuccess: () => client.invalidateQueries({ queryKey: key }) });
  if (!sessionId) return null;
  const checks = query.data?.checks ?? [];
  const latest = checks[0];
  return <details className="mx-4 my-1 rounded-lg border border-outline-variant/20 px-3 py-2 text-xs" data-testid="learning-panel">
    <summary className="cursor-pointer text-on-surface-variant">Learning · {query.isError ? 'unavailable' : query.isLoading ? 'loading' : latest ? latest.stage?.replaceAll('_', ' ') ?? latest.status : 'no checks yet'}</summary>
    <p className="my-2 text-on-surface-variant">Checks recorded execution evidence for project knowledge, personal memory, and skill proposals. Chat replies stay concise.</p>
    <button type="button" className="rounded bg-primary/10 px-2 py-1 text-primary" disabled={check.isPending || latest?.status === 'queued' || latest?.status === 'running'}
      onClick={() => check.mutate()}>Check recent work</button>
    {(query.isError || check.isError) && <p role="alert" className="mt-2 text-error">{String((query.error ?? check.error)?.message ?? 'Learning checks unavailable')}</p>}
    <div className="max-h-60 overflow-auto">
      {checks.map(item => <div key={item.id} className="mt-3 border-t border-outline-variant/20 pt-2">
        <p>{item.title} · {item.status} · {new Date(item.createdAt).toLocaleString()}</p>
        <p className="text-on-surface-variant">{item.result?.reason ?? item.stage?.replaceAll('_', ' ')}</p>
        {item.error && <p className="text-error">{item.error}</p>}
        {item.result?.outputs?.map((output, index) => <p key={`${output.kind}-${index}`}>
          {output.kind}: {output.status.replaceAll('_', ' ')}{output.detail ? ` — ${output.detail}` : ''}
          {output.id && <span className="ml-1 text-on-surface-variant">({output.id})</span>}
        </p>)}
      </div>)}
    </div>
    <a href="/skills" className="mt-2 inline-block text-primary hover:underline">Review skills</a>
  </details>;
}
