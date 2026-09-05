'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bot, ChevronLeft, ChevronRight, Loader2, Square, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { Portal } from '@/components/ui/portal';
import { StatusBadge, type StatusVariant } from '@/components/ui/status-badge';
import { api } from '@/lib/api';

interface Agent {
  id: string;
  sessionId: string;
  userId: string;
  status: 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';
  topic: string;
  model: string;
  role: string;
  createdAt: string;
  iteration: number;
}

function AgentStatusBadge({ status }: { status: Agent['status'] }) {
  const variants: Record<Agent['status'], StatusVariant> = {
    idle: 'neutral',
    running: 'success',
    paused: 'warning',
    stopped: 'neutral',
    completed: 'info',
    failed: 'danger',
  };
  return (
    <StatusBadge variant={variants[status] ?? 'neutral'} dot pulse={status === 'running'}>
      {status}
    </StatusBadge>
  );
}

interface NewAgentModalProps {
  open: boolean;
  onClose: () => void;
}

function NewAgentModal({ open, onClose }: NewAgentModalProps) {
  const [task, setTask] = useState('');
  const [role, setRole] = useState('general');
  const [model, setModel] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const handleSubmit = async () => {
    if (!task.trim()) return;
    setIsSubmitting(true);
    setError('');

    try {
      // Use the chat endpoint which routes through the root agent
      const _result = await api.post<{ response: string; agentId?: string; sessionId: string }>('/chat', {
        message: task,
      });

      onClose();
      setTask('');
      setRole('general');
      setModel('');
    } catch (err) {
      setError((err as Error).message);
    }

    setIsSubmitting(false);
  };

  return (
    <Portal>
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-container rounded-xs shadow-xl border border-outline-variant/10 w-full max-w-lg mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-on-surface lowercase term-prompt">New Agent</h2>
          <button onClick={onClose} className="p-1 text-on-surface-variant hover:text-on-surface cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-on-surface-variant mb-1">
              Task Description
            </label>
            <textarea
              value={task}
              onChange={e => setTask(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary/40 focus:border-primary text-on-surface"
              placeholder="Describe what the agent should do..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-on-surface-variant mb-1">
                Role
              </label>
              <select
                value={role}
                onChange={e => setRole(e.target.value)}
                className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary/40 focus:border-primary text-on-surface"
              >
                <option value="general">General</option>
                <option value="coding">Coding</option>
                <option value="research">Research</option>
                <option value="review">Code Review</option>
                <option value="qa">QA Testing</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface-variant mb-1">
                Model (optional)
              </label>
              <input
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary/40 focus:border-primary text-on-surface"
                placeholder="auto"
              />
            </div>
          </div>

          {error && (
            <p className="text-sm text-error">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !task.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary cursor-pointer rounded-full hover:opacity-90 disabled:opacity-50 text-sm font-medium"
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Bot className="w-4 h-4" />
              )}
              Spawn Agent
            </button>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}

const PAGE_SIZE = 50;

interface AgentsResponse {
  agents: Agent[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export default function AgentsPage() {
  const router = useRouter();
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [offset, setOffset] = useState(0);

  const { data, isLoading } = useQuery({
    queryKey: ['agents', offset],
    queryFn: async () => {
      try {
        return await api.get<AgentsResponse>(`/agents?limit=${PAGE_SIZE}&offset=${offset}`);
      } catch {
        return { agents: [], total: 0, limit: PAGE_SIZE, offset, hasMore: false };
      }
    },
    // Live agents only change on the first page; history is static, so we
    // only poll page 0. Slower cadence (5s) than the old 2s to cut churn.
    // Keep the previous page visible while the next loads to avoid flicker.
    refetchInterval: offset === 0 ? 5000 : false,
    placeholderData: keepPreviousData,
  });

  const agents = data?.agents ?? [];
  const total = data?.total ?? 0;
  const hasMore = data?.hasMore ?? false;

  const handleStop = async (agentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.post(`/agents/${agentId}/stop`);
    } catch {
      // Ignore
    }
  };

  const handleRemove = async (agentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.delete(`/agents/${agentId}`);
    } catch {
      // Ignore
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="agents"
        description="monitor and manage running ai agents — status, tool calls, iterations, results"
        actions={
          <button
            onClick={() => setShowNewAgent(true)}
            className="px-4 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary cursor-pointer rounded-full hover:opacity-90 flex items-center gap-2 font-medium"
          >
            <Bot className="w-4 h-4" />
            New Agent
          </button>
        }
      />

      <div className="bg-surface-container rounded-xs border border-outline-variant/10">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-outline-variant/10">
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Agent</th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Status</th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Role</th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Model</th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Iterations</th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Created</th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Actions</th>
              </tr>
            </thead>
            <tbody className="stagger">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-on-surface-variant">
                    <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                    Loading...
                  </td>
                </tr>
              ) : agents.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center font-mono">
                    <span aria-hidden className="block text-lg text-outline mb-2">[ ]</span>
                    <span className="text-[12px] text-on-surface-variant">
                      no agents running — click &quot;New Agent&quot; to spawn one with a task and role
                    </span>
                  </td>
                </tr>
              ) : (
                agents.map((agent) => (
                  <tr
                    key={agent.id}
                    onClick={() => router.push(`/agents/view?id=${agent.id}`)}
                    className="border-b border-outline-variant/10 hover:bg-surface-container-high cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Bot className="w-5 h-5 text-on-surface-variant" />
                        <span className="font-mono text-sm">{agent.id.slice(0, 8)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3"><AgentStatusBadge status={agent.status} /></td>
                    <td className="px-4 py-3 text-sm capitalize">{agent.role}</td>
                    <td className="px-4 py-3 text-sm font-mono">{agent.model}</td>
                    <td className="px-4 py-3 text-sm">{agent.iteration}</td>
                    <td className="px-4 py-3 text-sm" suppressHydrationWarning>
                      {new Date(agent.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {agent.status === 'running' && (
                          <button
                            onClick={(e) => handleStop(agent.id, e)}
                            className="p-1.5 text-error hover:bg-error/10 rounded cursor-pointer"
                            title="Stop"
                          >
                            <Square className="w-4 h-4" />
                          </button>
                        )}
                        {agent.status !== 'running' && (
                          <button
                            onClick={(e) => handleRemove(agent.id, e)}
                            className="p-1.5 text-on-surface-variant hover:text-error hover:bg-error/10 rounded cursor-pointer"
                            title="Remove"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-on-surface-variant">
          <span className="font-mono text-[12px]">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              disabled={offset === 0}
              className="flex items-center gap-1 px-3 py-1.5 rounded-full border border-outline-variant/20 hover:bg-surface-container-high disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
              Prev
            </button>
            <button
              type="button"
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              disabled={!hasMore}
              className="flex items-center gap-1 px-3 py-1.5 rounded-full border border-outline-variant/20 hover:bg-surface-container-high disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <NewAgentModal open={showNewAgent} onClose={() => setShowNewAgent(false)} />
    </div>
  );
}
