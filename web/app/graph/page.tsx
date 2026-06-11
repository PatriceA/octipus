'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, Network } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';

interface GraphNode { type: string; id: string; slug?: string; label?: string; kind?: string }
interface GraphEdge { id: string; from: { type: string; id: string }; to: { type: string; id: string } | null; toRef: string; linkType: string; origin: string; resolved: boolean }
interface GraphResponse { nodes: GraphNode[]; edges: GraphEdge[] }

// Above this node count the O(n²) force relaxation gets too heavy to run on
// every render; we fall back to the cheap ring layout instead.
const FORCE_LAYOUT_MAX_NODES = 280;

/**
 * Knowledge graph view. Dependency-free SVG. Nodes are placed by a small
 * Fruchterman-Reingold force simulation (run synchronously in a memo, seeded
 * from a ring so it's deterministic — no Math.random) so LINKED notes pull
 * together into clusters and unconnected notes drift apart, instead of every
 * node sitting on one circle regardless of its links (the QA: connected notes
 * "are also not close to each other"). Large graphs fall back to the ring.
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
    const n = nodes.length;
    const pos = new Map<string, { x: number; y: number }>();
    if (n === 0) return { W, H, pos };

    const keyOf = (nd: GraphNode) => `${nd.type}:${nd.id}`;
    const ringR = Math.min(W, H) / 2 - 60;
    // Seed every node on a ring (deterministic starting state).
    const p = nodes.map((_, i) => {
      const a = (2 * Math.PI * i) / n;
      return { x: cx + ringR * Math.cos(a), y: cy + ringR * Math.sin(a) };
    });

    if (n <= FORCE_LAYOUT_MAX_NODES) {
      const idx = new Map(nodes.map((nd, i) => [keyOf(nd), i]));
      const links = (graph.data?.edges ?? [])
        .filter((e) => e.resolved && e.to)
        .map((e) => [idx.get(`${e.from.type}:${e.from.id}`), e.to ? idx.get(`${e.to.type}:${e.to.id}`) : undefined])
        .filter((l): l is [number, number] => l[0] !== undefined && l[1] !== undefined && l[0] !== l[1]);

      const k = Math.sqrt((W * H) / n); // ideal edge length
      let temp = W / 8;
      const iters = Math.min(300, 80 + n * 2);
      for (let it = 0; it < iters; it++) {
        const disp = p.map(() => ({ x: 0, y: 0 }));
        // Repulsion between every pair.
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const dx = p[i].x - p[j].x;
            const dy = p[i].y - p[j].y;
            const dist = Math.hypot(dx, dy) || 0.01;
            const force = (k * k) / dist;
            const ux = dx / dist;
            const uy = dy / dist;
            disp[i].x += ux * force; disp[i].y += uy * force;
            disp[j].x -= ux * force; disp[j].y -= uy * force;
          }
        }
        // Attraction along edges.
        for (const [a, b] of links) {
          const dx = p[a].x - p[b].x;
          const dy = p[a].y - p[b].y;
          const dist = Math.hypot(dx, dy) || 0.01;
          const force = (dist * dist) / k;
          const ux = dx / dist;
          const uy = dy / dist;
          disp[a].x -= ux * force; disp[a].y -= uy * force;
          disp[b].x += ux * force; disp[b].y += uy * force;
        }
        // Apply, capped by the cooling temperature, clamped to the viewport.
        for (let i = 0; i < n; i++) {
          const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
          p[i].x += (disp[i].x / d) * Math.min(d, temp);
          p[i].y += (disp[i].y / d) * Math.min(d, temp);
          p[i].x = Math.max(30, Math.min(W - 30, p[i].x));
          p[i].y = Math.max(30, Math.min(H - 30, p[i].y));
        }
        temp *= 0.96; // cool down
      }
    }

    nodes.forEach((nd, i) => pos.set(keyOf(nd), p[i]));
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
              const fromKey = `${e.from.type}:${e.from.id}`;
              const toKey = e.to ? `${e.to.type}:${e.to.id}` : '';
              const a = layout.pos.get(fromKey);
              const b = toKey ? layout.pos.get(toKey) : undefined;
              if (!a || !b) return null;
              // When a node is selected, foreground its incident edges and fade
              // the rest so the local neighbourhood stands out.
              const incident = selected === fromKey || selected === toKey;
              const opacity = selected ? (incident ? 0.55 : 0.06) : 0.2;
              return (
                <line
                  key={e.id}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={incident ? '#6366f1' : 'currentColor'}
                  strokeOpacity={opacity}
                  strokeWidth={incident ? 1.5 : 1}
                />
              );
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
