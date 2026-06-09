'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, Network } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';

interface GraphNode { type: string; id: string; slug?: string; label?: string; kind?: string }
interface GraphEdge { id: string; from: { type: string; id: string }; to: { type: string; id: string } | null; toRef: string; linkType: string; origin: string; resolved: boolean }
interface GraphResponse { nodes: GraphNode[]; edges: GraphEdge[] }

/**
 * Knowledge graph view. Dependency-free SVG with a deterministic circular
 * layout — nodes on a ring, resolved edges as lines. Good enough to see
 * clusters and hubs without pulling in a physics library.
 */
export default function GraphPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const graph = useQuery<GraphResponse>({
    queryKey: ['graph'],
    queryFn: () => api.get<GraphResponse>('/graph'),
  });

  const layout = useMemo(() => {
    const nodes = graph.data?.nodes ?? [];
    const W = 900;
    const H = 600;
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.min(W, H) / 2 - 60;
    const pos = new Map<string, { x: number; y: number }>();
    nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, nodes.length);
      pos.set(`${n.type}:${n.id}`, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    });
    return { W, H, pos };
  }, [graph.data]);

  const edges = (graph.data?.edges ?? []).filter((e) => e.resolved && e.to);

  return (
    <div className="p-6 h-full overflow-auto">
      <h1 className="text-xl font-semibold flex items-center gap-2 mb-4"><Network size={20} /> Knowledge Graph</h1>
      {graph.isLoading && <Loader2 className="animate-spin" size={18} />}
      {graph.data && graph.data.nodes.length === 0 && (
        <p className="text-muted-foreground">No notes yet — create some notes with [[wikilinks]] to grow the graph.</p>
      )}
      {graph.data && graph.data.nodes.length > 0 && (
        <div className="flex gap-6">
          <svg viewBox={`0 0 ${layout.W} ${layout.H}`} className="border border-border rounded bg-card flex-1 max-w-4xl">
            <title>Knowledge graph</title>
            {edges.map((e) => {
              const a = layout.pos.get(`${e.from.type}:${e.from.id}`);
              const b = e.to ? layout.pos.get(`${e.to.type}:${e.to.id}`) : undefined;
              if (!a || !b) return null;
              return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeOpacity={0.2} strokeWidth={1} />;
            })}
            {graph.data.nodes.map((n) => {
              const p = layout.pos.get(`${n.type}:${n.id}`);
              if (!p) return null;
              const key = `${n.type}:${n.id}`;
              return (
                <g key={key} transform={`translate(${p.x},${p.y})`} className="cursor-pointer" onClick={() => setSelected(key)}>
                  <circle r={selected === key ? 8 : 5} fill={n.kind === 'daily' ? '#22c55e' : n.kind === 'moc' ? '#f59e0b' : '#6366f1'} />
                  <text x={9} y={4} fontSize={10} fill="currentColor" className="select-none">{n.label?.slice(0, 24)}</text>
                </g>
              );
            })}
          </svg>
          <aside className="w-64 text-sm">
            <p className="text-muted-foreground mb-2">{graph.data.nodes.length} nodes · {edges.length} resolved edges</p>
            <ul className="space-y-1">
              <li><span className="inline-block w-3 h-3 rounded-full align-middle mr-1" style={{ background: '#6366f1' }} /> note</li>
              <li><span className="inline-block w-3 h-3 rounded-full align-middle mr-1" style={{ background: '#22c55e' }} /> daily</li>
              <li><span className="inline-block w-3 h-3 rounded-full align-middle mr-1" style={{ background: '#f59e0b' }} /> moc / review</li>
            </ul>
          </aside>
        </div>
      )}
    </div>
  );
}
