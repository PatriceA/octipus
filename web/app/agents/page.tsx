'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Bot, Play, Pause, Square, Clock, CheckCircle, XCircle, X, Loader2, Trash2, Ban } from 'lucide-react';
import { cn } from '@/lib/utils';
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

function StatusBadge({ status }: { status: Agent['status'] }) {
  const config: Record<string, { color: string; icon: typeof Play }> = {
    idle: { color: 'bg-gray-100 text-gray-800', icon: Clock },
    running: { color: 'bg-green-100 text-green-800', icon: Play },
    paused: { color: 'bg-yellow-100 text-yellow-800', icon: Pause },
    stopped: { color: 'bg-gray-100 text-gray-800', icon: Ban },
    completed: { color: 'bg-blue-100 text-blue-800', icon: CheckCircle },
    failed: { color: 'bg-red-100 text-red-800', icon: XCircle },
  };
  const { color, icon: Icon } = config[status] || config.idle;

  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium', color)}>
      <Icon className="w-3 h-3" />
      {status}
    </span>
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
      // Use the chat endpoint which routes through the orchestrator
      const result = await api.post<{ response: string; agentId?: string; sessionId: string }>('/chat', {
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">New Agent</h2>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-600 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Task Description
            </label>
            <textarea
              value={task}
              onChange={e => setTask(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
              placeholder="Describe what the agent should do..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Role
              </label>
              <select
                value={role}
                onChange={e => setRole(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
              >
                <option value="general">General</option>
                <option value="coding">Coding</option>
                <option value="research">Research</option>
                <option value="review">Code Review</option>
                <option value="qa">QA Testing</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Model (optional)
              </label>
              <input
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
                placeholder="auto"
              />
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !task.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 disabled:opacity-50 text-sm"
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
  );
}

export default function AgentsPage() {
  const router = useRouter();
  const [showNewAgent, setShowNewAgent] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      try {
        const res = await api.get<{ agents: Agent[] }>('/agents');
        return res?.agents || [];
      } catch {
        return [];
      }
    },
    refetchInterval: 2000,
  });

  const agents = Array.isArray(data) ? data : [];

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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
            <Bot className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Agents</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Manage running and completed agents</p>
          </div>
        </div>
        <button
          onClick={() => setShowNewAgent(true)}
          className="px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 flex items-center gap-2"
        >
          <Bot className="w-4 h-4" />
          New Agent
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Agent</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Role</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Model</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Iterations</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Created</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                    Loading...
                  </td>
                </tr>
              ) : agents.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    No agents running. Click "New Agent" to start one.
                  </td>
                </tr>
              ) : (
                agents.map((agent) => (
                  <tr
                    key={agent.id}
                    onClick={() => router.push(`/agents/${agent.id}`)}
                    className="border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Bot className="w-5 h-5 text-gray-500" />
                        <span className="font-mono text-sm">{agent.id.slice(0, 8)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={agent.status} /></td>
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
                            className="p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded cursor-pointer"
                            title="Stop"
                          >
                            <Square className="w-4 h-4" />
                          </button>
                        )}
                        {agent.status !== 'running' && (
                          <button
                            onClick={(e) => handleRemove(agent.id, e)}
                            className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded cursor-pointer"
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

      <NewAgentModal open={showNewAgent} onClose={() => setShowNewAgent(false)} />
    </div>
  );
}
