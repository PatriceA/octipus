'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Webhook, Plus, ToggleLeft, ToggleRight, Trash2, Edit, X, Loader2, Info } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Hook {
  id: string;
  name: string;
  description?: string;
  trigger: string;
  triggerConfig: Record<string, unknown>;
  action: string;
  actionConfig: Record<string, unknown>;
  isEnabled: boolean;
  executionCount: number;
  lastExecutedAt?: string;
}

const TRIGGER_OPTIONS = [
  { value: 'message_received', label: 'Message Received', desc: 'Fires when a new message arrives' },
  { value: 'agent_completed', label: 'Agent Completed', desc: 'Fires when an agent finishes' },
  { value: 'agent_failed', label: 'Agent Failed', desc: 'Fires when an agent errors' },
  { value: 'webhook', label: 'Webhook', desc: 'Fires when an external HTTP request hits /api/webhooks/:path' },
  { value: 'schedule', label: 'Schedule', desc: 'Fires on a cron schedule' },
];

const ACTION_OPTIONS = [
  { value: 'notify', label: 'Notify', desc: 'Send a notification to a channel' },
  { value: 'spawn_agent', label: 'Spawn Agent', desc: 'Start an agent (direct or orchestrated)' },
  { value: 'webhook', label: 'Outgoing Webhook', desc: 'Send an HTTP request' },
  { value: 'n8n_workflow', label: 'N8N Workflow', desc: 'Trigger an N8N workflow' },
  { value: 'execute_skill', label: 'Execute Skill', desc: 'Run a specific skill tool' },
];

interface CreateHookModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function CreateHookModal({ open, onClose, onCreated }: CreateHookModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [trigger, setTrigger] = useState('webhook');
  const [action, setAction] = useState('spawn_agent');
  const [webhookPath, setWebhookPath] = useState('');
  const [cronExpression, setCronExpression] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');
  const [orchestrated, setOrchestrated] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setIsSubmitting(true);
    setError('');

    try {
      const triggerConfig: Record<string, unknown> = {};
      if (trigger === 'webhook') triggerConfig.webhookPath = webhookPath;
      if (trigger === 'schedule') triggerConfig.cronExpression = cronExpression;

      const actionConfig: Record<string, unknown> = {};
      if (action === 'spawn_agent') {
        actionConfig.agentPrompt = agentPrompt;
        actionConfig.orchestrated = orchestrated;
      }

      await api.post('/hooks', {
        name,
        description,
        trigger,
        triggerConfig,
        action,
        actionConfig,
        isEnabled: true,
      });

      onCreated();
      onClose();
      // Reset form
      setName('');
      setDescription('');
      setTrigger('webhook');
      setAction('spawn_agent');
      setWebhookPath('');
      setCronExpression('');
      setAgentPrompt('');
      setOrchestrated(true);
    } catch (err) {
      setError((err as Error).message);
    }

    setIsSubmitting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Create Hook</h2>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-600 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Name & Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
              placeholder="e.g., GitHub PR Review"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
              placeholder="What this hook does"
            />
          </div>

          {/* Trigger */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Trigger</label>
            <select
              value={trigger}
              onChange={e => setTrigger(e.target.value)}
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
            >
              {TRIGGER_OPTIONS.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              {TRIGGER_OPTIONS.find(t => t.value === trigger)?.desc}
            </p>
          </div>

          {/* Trigger-specific config */}
          {trigger === 'webhook' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Webhook Path
              </label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-gray-500">/api/webhooks/</span>
                <input
                  type="text"
                  value={webhookPath}
                  onChange={e => setWebhookPath(e.target.value)}
                  className="flex-1 px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
                  placeholder="github"
                />
              </div>
            </div>
          )}

          {trigger === 'schedule' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Cron Expression
              </label>
              <input
                type="text"
                value={cronExpression}
                onChange={e => setCronExpression(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200 font-mono"
                placeholder="0 9 * * MON-FRI"
              />
            </div>
          )}

          {/* Action */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Action</label>
            <select
              value={action}
              onChange={e => setAction(e.target.value)}
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
            >
              {ACTION_OPTIONS.map(a => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              {ACTION_OPTIONS.find(a => a.value === action)?.desc}
            </p>
          </div>

          {/* Action-specific config */}
          {action === 'spawn_agent' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Agent Prompt
                </label>
                <textarea
                  value={agentPrompt}
                  onChange={e => setAgentPrompt(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
                  placeholder="Review the changes in this PR against our code guidelines..."
                />
                <p className="mt-1 text-xs text-gray-500">
                  Use {'{{webhook.body.field}}'} for template variables
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={orchestrated}
                  onChange={e => setOrchestrated(e.target.checked)}
                  className="rounded"
                />
                Route through orchestrator (recommended — enables multi-stage pipelines)
              </label>
            </>
          )}

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
              disabled={isSubmitting || !name.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 disabled:opacity-50 text-sm"
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              Create Hook
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HooksPage() {
  const [showCreate, setShowCreate] = useState(false);
  const queryClient = useQueryClient();

  const { data: hooks = [], isLoading } = useQuery({
    queryKey: ['hooks'],
    queryFn: async () => {
      try {
        const res = await api.get<{ hooks: Hook[] }>('/hooks');
        return res?.hooks || [];
      } catch {
        return [];
      }
    },
  });

  const handleToggle = async (hookId: string, currentEnabled: boolean) => {
    try {
      await api.patch(`/hooks/${hookId}`, { isEnabled: !currentEnabled });
      queryClient.invalidateQueries({ queryKey: ['hooks'] });
    } catch {
      // Ignore
    }
  };

  const handleDelete = async (hookId: string) => {
    if (!confirm('Delete this hook?')) return;
    try {
      await api.delete(`/hooks/${hookId}`);
      queryClient.invalidateQueries({ queryKey: ['hooks'] });
    } catch {
      // Ignore
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
            <Webhook className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Hooks</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Automate actions with event-driven hooks</p>
          </div>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 flex items-center gap-2 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Create Hook
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Name</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Trigger</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Action</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Executions</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                    Loading...
                  </td>
                </tr>
              ) : hooks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    <div className="flex flex-col items-center gap-2">
                      <Webhook className="w-8 h-8 text-gray-500" />
                      <p>No hooks configured</p>
                      <p className="text-sm">Create a hook to automate actions based on events</p>
                    </div>
                  </td>
                </tr>
              ) : (
                hooks.map((hook) => (
                  <tr key={hook.id} className="border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{hook.name}</p>
                        {hook.description && (
                          <p className="text-sm text-gray-500">{hook.description}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-xs rounded">{hook.trigger}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 text-xs rounded">
                        {hook.action}
                        {Boolean(hook.actionConfig?.orchestrated) && (
                          <span className="ml-1 text-orange-600" title="Orchestrated">*</span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">{hook.executionCount}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggle(hook.id, hook.isEnabled)}
                        className="text-gray-500 hover:text-gray-600 cursor-pointer"
                      >
                        {hook.isEnabled ? (
                          <ToggleRight className="w-6 h-6 text-green-500" />
                        ) : (
                          <ToggleLeft className="w-6 h-6" />
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleDelete(hook.id)}
                          className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded cursor-pointer"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <CreateHookModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['hooks'] })}
      />
    </div>
  );
}
