'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Webhook, Plus, ToggleLeft, ToggleRight, Trash2, Pencil, X, Loader2, Info, Lightbulb, Save, History, ChevronDown, ChevronUp, CheckCircle2, XCircle, Clock, Play } from 'lucide-react';
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
  nextRunAt?: string;
  lastError?: string;
}

interface HookExecution {
  id: string;
  hookId?: string;
  recurringTaskId?: string;
  source: 'hook' | 'recurring_task' | 'manual_test';
  status: 'success' | 'error' | 'skipped';
  triggerType?: string;
  actionType?: string;
  result?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  triggerContext?: Record<string, unknown>;
  createdAt: string;
}

function ExecutionLog({ hookId }: { hookId?: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['hook-executions', hookId || 'all'],
    queryFn: async () => {
      try {
        const url = hookId
          ? `/hooks/${hookId}/executions?limit=20`
          : '/hooks/executions/all?limit=30';
        const res = await api.get<{ executions: HookExecution[]; total: number }>(url);
        return res;
      } catch {
        return { executions: [], total: 0 };
      }
    },
    refetchInterval: 30000,
  });

  const executions = data?.executions || [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading execution history...
      </div>
    );
  }

  if (executions.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <History className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p>No executions yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {executions.map((exec) => (
        <div key={exec.id} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpanded(expanded === exec.id ? null : exec.id)}
            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 text-left cursor-pointer"
          >
            {exec.status === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
            ) : exec.status === 'error' ? (
              <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
            ) : (
              <Clock className="w-4 h-4 text-yellow-500 flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                  {exec.source === 'recurring_task' ? 'task' : exec.source}
                </span>
                {exec.triggerType && (
                  <span className="text-xs text-gray-500">{exec.triggerType}</span>
                )}
                {exec.actionType && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                    {exec.actionType}
                  </span>
                )}
                {exec.durationMs !== undefined && (
                  <span className="text-xs text-gray-400">{exec.durationMs}ms</span>
                )}
              </div>
              {exec.error && (
                <p className="text-xs text-red-500 truncate mt-0.5">{exec.error}</p>
              )}
            </div>
            <span className="text-xs text-gray-400 flex-shrink-0">
              {new Date(exec.createdAt).toLocaleString()}
            </span>
            {expanded === exec.id ? (
              <ChevronUp className="w-4 h-4 text-gray-400 flex-shrink-0" />
            ) : (
              <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
            )}
          </button>
          {expanded === exec.id && (
            <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 space-y-2">
              {exec.error && (
                <div>
                  <p className="text-xs font-medium text-red-600 dark:text-red-400">Error</p>
                  <p className="text-xs text-red-500 font-mono whitespace-pre-wrap">{exec.error}</p>
                </div>
              )}
              {exec.result && (
                <div>
                  <p className="text-xs font-medium text-gray-600 dark:text-gray-400">Result</p>
                  <pre className="text-xs text-gray-600 dark:text-gray-400 font-mono whitespace-pre-wrap overflow-x-auto max-h-40 overflow-y-auto">
                    {JSON.stringify(exec.result, null, 2)}
                  </pre>
                </div>
              )}
              {exec.triggerContext && (
                <div>
                  <p className="text-xs font-medium text-gray-600 dark:text-gray-400">Trigger Context</p>
                  <pre className="text-xs text-gray-600 dark:text-gray-400 font-mono whitespace-pre-wrap overflow-x-auto max-h-40 overflow-y-auto">
                    {JSON.stringify(exec.triggerContext, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {(data?.total || 0) > executions.length && (
        <p className="text-xs text-center text-gray-400 py-1">
          Showing {executions.length} of {data?.total} executions
        </p>
      )}
    </div>
  );
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
  { value: 'execute_tool', label: 'Execute Tool', desc: 'Run a specific tool action' },
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

interface EditHookModalProps {
  hook: Hook;
  onClose: () => void;
  onSaved: () => void;
}

function EditHookModal({ hook, onClose, onSaved }: EditHookModalProps) {
  const [name, setName] = useState(hook.name);
  const [description, setDescription] = useState(hook.description || '');
  const [trigger, setTrigger] = useState(hook.trigger);
  const [action, setAction] = useState(hook.action);

  // Trigger config
  const [webhookPath, setWebhookPath] = useState((hook.triggerConfig?.webhookPath as string) || '');
  const [cronExpression, setCronExpression] = useState((hook.triggerConfig?.cronExpression as string) || '');
  const [messagePattern, setMessagePattern] = useState((hook.triggerConfig?.pattern as string) || '');

  // Action config — spawn_agent
  const [agentPrompt, setAgentPrompt] = useState((hook.actionConfig?.agentPrompt as string) || '');
  const [orchestrated, setOrchestrated] = useState(Boolean(hook.actionConfig?.orchestrated));
  const [agentTopic, setAgentTopic] = useState((hook.actionConfig?.agentTopic as string) || '');
  const [agentModel, setAgentModel] = useState((hook.actionConfig?.agentModel as string) || '');

  // Action config — notify
  const [notifyChannels, setNotifyChannels] = useState((hook.actionConfig?.notifyChannels as string[] || []).join(', '));
  const [notifyMessage, setNotifyMessage] = useState((hook.actionConfig?.notifyMessage as string) || '');

  // Action config — outgoing webhook
  const [webhookUrl, setWebhookUrl] = useState((hook.actionConfig?.webhookUrl as string) || '');
  const [webhookMethod, setWebhookMethod] = useState((hook.actionConfig?.webhookMethod as string) || 'POST');
  const [webhookBody, setWebhookBody] = useState((hook.actionConfig?.webhookBody as string) || '');

  // Action config — n8n_workflow
  const [workflowId, setWorkflowId] = useState((hook.actionConfig?.workflowId as string) || '');

  // Action config — execute_tool (tool)
  const [toolId, setToolId] = useState((hook.actionConfig?.toolId as string) || '');
  const [toolAction, setToolAction] = useState((hook.actionConfig?.toolAction as string) || '');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const buildTriggerConfig = (): Record<string, unknown> => {
    const cfg: Record<string, unknown> = {};
    if (trigger === 'webhook') cfg.webhookPath = webhookPath;
    if (trigger === 'schedule') cfg.cronExpression = cronExpression;
    if (trigger === 'message_received' && messagePattern) cfg.pattern = messagePattern;
    return cfg;
  };

  const buildActionConfig = (): Record<string, unknown> => {
    const cfg: Record<string, unknown> = {};
    switch (action) {
      case 'spawn_agent':
        cfg.agentPrompt = agentPrompt;
        cfg.orchestrated = orchestrated;
        if (agentTopic) cfg.agentTopic = agentTopic;
        if (agentModel) cfg.agentModel = agentModel;
        break;
      case 'notify':
        cfg.notifyChannels = notifyChannels.split(',').map(s => s.trim()).filter(Boolean);
        cfg.notifyMessage = notifyMessage;
        break;
      case 'webhook':
        cfg.webhookUrl = webhookUrl;
        cfg.webhookMethod = webhookMethod;
        if (webhookBody) cfg.webhookBody = webhookBody;
        break;
      case 'n8n_workflow':
        cfg.workflowId = workflowId;
        break;
      case 'execute_tool':
        cfg.toolId = toolId;
        cfg.toolAction = toolAction;
        break;
    }
    return cfg;
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setIsSubmitting(true);
    setError('');

    try {
      await api.patch(`/hooks/${hook.id}`, {
        name,
        description,
        triggerConfig: buildTriggerConfig(),
        actionConfig: buildActionConfig(),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
    setIsSubmitting(false);
  };

  const inputCls = 'w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit Hook</h2>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-600 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Name & Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)} className={inputCls} />
          </div>

          {/* Trigger (read-only label + config) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Trigger</label>
            <div className="px-3 py-2 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm text-gray-700 dark:text-gray-300">
              {TRIGGER_OPTIONS.find(t => t.value === trigger)?.label || trigger}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {TRIGGER_OPTIONS.find(t => t.value === trigger)?.desc}
            </p>
          </div>

          {/* Trigger-specific config */}
          {trigger === 'webhook' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Webhook Path</label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-gray-500">/api/webhooks/</span>
                <input type="text" value={webhookPath} onChange={e => setWebhookPath(e.target.value)} className={'flex-1 ' + inputCls.replace('w-full ', '')} placeholder="github" />
              </div>
            </div>
          )}
          {trigger === 'schedule' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cron Expression</label>
              <input type="text" value={cronExpression} onChange={e => setCronExpression(e.target.value)} className={inputCls + ' font-mono'} placeholder="0 9 * * MON-FRI" />
            </div>
          )}
          {trigger === 'message_received' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Message Pattern (optional regex)</label>
              <input type="text" value={messagePattern} onChange={e => setMessagePattern(e.target.value)} className={inputCls + ' font-mono'} placeholder=".*deploy.*" />
            </div>
          )}

          {/* Action (read-only label + config) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Action</label>
            <div className="px-3 py-2 bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm text-gray-700 dark:text-gray-300">
              {ACTION_OPTIONS.find(a => a.value === action)?.label || action}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {ACTION_OPTIONS.find(a => a.value === action)?.desc}
            </p>
          </div>

          {/* Action-specific config */}
          {action === 'spawn_agent' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Agent Prompt</label>
                <textarea value={agentPrompt} onChange={e => setAgentPrompt(e.target.value)} rows={3} className={inputCls} placeholder="Review the changes..." />
                <p className="mt-1 text-xs text-gray-500">Use {'{{webhook.body.field}}'} for template variables</p>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={orchestrated} onChange={e => setOrchestrated(e.target.checked)} className="rounded" />
                Route through orchestrator
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Topic (optional)</label>
                  <input type="text" value={agentTopic} onChange={e => setAgentTopic(e.target.value)} className={inputCls} placeholder="coding" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model (optional)</label>
                  <input type="text" value={agentModel} onChange={e => setAgentModel(e.target.value)} className={inputCls} placeholder="default" />
                </div>
              </div>
            </>
          )}

          {action === 'notify' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Channels</label>
                <input type="text" value={notifyChannels} onChange={e => setNotifyChannels(e.target.value)} className={inputCls} placeholder="telegram:123456, slack:general" />
                <p className="mt-1 text-xs text-gray-500">Comma-separated, format: type:channelId</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Message Template</label>
                <textarea value={notifyMessage} onChange={e => setNotifyMessage(e.target.value)} rows={2} className={inputCls} placeholder="Hook triggered: {{event.type}}" />
              </div>
            </>
          )}

          {action === 'webhook' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Webhook URL</label>
                <input type="text" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} className={inputCls} placeholder="https://example.com/webhook" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">HTTP Method</label>
                <select value={webhookMethod} onChange={e => setWebhookMethod(e.target.value)} className={inputCls}>
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Body Template (optional)</label>
                <textarea value={webhookBody} onChange={e => setWebhookBody(e.target.value)} rows={3} className={inputCls + ' font-mono'} placeholder='{"event": "{{event.type}}"}' />
              </div>
            </>
          )}

          {action === 'n8n_workflow' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Workflow ID</label>
              <input type="text" value={workflowId} onChange={e => setWorkflowId(e.target.value)} className={inputCls} placeholder="1" />
            </div>
          )}

          {action === 'execute_tool' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tool ID</label>
                <input type="text" value={toolId} onChange={e => setToolId(e.target.value)} className={inputCls} placeholder="shell" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tool Action</label>
                <input type="text" value={toolAction} onChange={e => setToolAction(e.target.value)} className={inputCls} placeholder="execute" />
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 cursor-pointer">
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !name.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 disabled:opacity-50 text-sm"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HooksPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [editingHook, setEditingHook] = useState<Hook | null>(null);
  const [activeTab, setActiveTab] = useState<'hooks' | 'tasks' | 'executions'>('hooks');
  const [viewingExecutions, setViewingExecutions] = useState<string | null>(null);
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

  const { data: suggestions = [] } = useQuery({
    queryKey: ['hook-suggestions'],
    queryFn: async () => {
      try {
        const res = await api.get<{ suggestions: Array<{ id: string; name: string; description: string; integration: string }> }>('/hooks/suggestions');
        return res?.suggestions || [];
      } catch {
        return [];
      }
    },
  });

  const applySuggestion = async (suggestionId: string) => {
    try {
      await api.post(`/hooks/suggestions/${suggestionId}/apply`);
      queryClient.invalidateQueries({ queryKey: ['hooks'] });
      queryClient.invalidateQueries({ queryKey: ['hook-suggestions'] });
    } catch {}
  };

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
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Hooks & Tasks</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Automate actions with events and schedules</p>
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

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {(['hooks', 'tasks', 'executions'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); setViewingExecutions(null); }}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px cursor-pointer',
              activeTab === tab
                ? 'border-primary-600 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            {tab === 'hooks' && <Webhook className="w-4 h-4 inline mr-1.5" />}
            {tab === 'tasks' && <Clock className="w-4 h-4 inline mr-1.5" />}
            {tab === 'executions' && <History className="w-4 h-4 inline mr-1.5" />}
            {tab === 'hooks' ? 'Hooks' : tab === 'tasks' ? 'Scheduled Tasks' : 'Execution Log'}
          </button>
        ))}
      </div>

      {activeTab === 'executions' && (
        <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-4">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            {viewingExecutions ? 'Hook Executions' : 'All Recent Executions'}
            {viewingExecutions && (
              <button
                onClick={() => setViewingExecutions(null)}
                className="ml-2 text-xs text-primary-600 hover:underline cursor-pointer"
              >
                Show all
              </button>
            )}
          </h2>
          <ExecutionLog hookId={viewingExecutions || undefined} />
        </div>
      )}

      {activeTab === 'tasks' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60">
            {isLoading ? (
              <div className="p-8 text-center text-gray-500">
                <Loader2 className="w-5 h-5 animate-spin inline mr-2" />Loading...
              </div>
            ) : hooks.filter(h => h.trigger === 'schedule').length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>No scheduled tasks</p>
                <p className="text-sm mt-1">Create a hook with &quot;Schedule&quot; trigger to add a recurring task</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-700/50">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Name</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Schedule</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Action</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Last Run</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Next Run</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Runs</th>
                    <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Status</th>
                    <th className="text-right px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {hooks.filter(h => h.trigger === 'schedule').map((hook) => (
                    <tr key={hook.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900 dark:text-gray-100">{hook.name}</div>
                        {hook.description && <div className="text-xs text-gray-500 mt-0.5">{hook.description}</div>}
                        {hook.lastError && <div className="text-xs text-red-500 mt-0.5">{hook.lastError}</div>}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">
                        {(hook.triggerConfig?.cronExpression as string) || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 text-xs rounded">
                          {hook.action}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {hook.lastExecutedAt ? new Date(hook.lastExecutedAt).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {hook.nextRunAt ? new Date(hook.nextRunAt).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{hook.executionCount}</td>
                      <td className="px-4 py-3">
                        <span className={cn(
                          'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                          hook.isEnabled && !hook.lastError ? 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400' :
                          hook.lastError ? 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400' :
                          'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
                        )}>
                          {!hook.isEnabled ? 'paused' : hook.lastError ? 'error' : 'active'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex gap-1 justify-end">
                          <button
                            onClick={() => { setViewingExecutions(hook.id); setActiveTab('executions'); }}
                            className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded cursor-pointer"
                            title="Execution log"
                          >
                            <History className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setEditingHook(hook)}
                            className="p-1 text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded cursor-pointer"
                            title="Edit"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleToggle(hook.id, hook.isEnabled)}
                            className="p-1 text-gray-400 hover:text-gray-600 rounded cursor-pointer"
                            title={hook.isEnabled ? 'Pause' : 'Resume'}
                          >
                            {hook.isEnabled ? <ToggleRight className="w-5 h-5 text-green-500" /> : <ToggleLeft className="w-5 h-5" />}
                          </button>
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
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {activeTab === 'hooks' && <>
      {/* Suggested hooks */}
      {suggestions.length > 0 && (
        <div className="bg-blue-50 dark:bg-blue-900/10 rounded-xl ring-1 ring-blue-200/60 dark:ring-blue-800/40 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Lightbulb className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span className="text-sm font-medium text-blue-800 dark:text-blue-300">Suggested Hooks</span>
            <span className="text-xs text-blue-600/60 dark:text-blue-400/60">Based on your configured integrations</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {suggestions.map((s) => (
              <div key={s.id} className="bg-white dark:bg-gray-800 rounded-lg p-3 ring-1 ring-gray-200/60 dark:ring-gray-700/60">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{s.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{s.description}</p>
                    <span className="inline-block mt-1 text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">{s.integration}</span>
                  </div>
                  <button
                    onClick={() => applySuggestion(s.id)}
                    className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 flex-shrink-0"
                  >
                    Add
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
              ) : hooks.filter(h => h.trigger !== 'schedule').length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    <div className="flex flex-col items-center gap-2">
                      <Webhook className="w-8 h-8 text-gray-500" />
                      <p>No event hooks configured</p>
                      <p className="text-sm">Create a hook to automate actions based on events</p>
                    </div>
                  </td>
                </tr>
              ) : (
                hooks.filter(h => h.trigger !== 'schedule').map((hook) => (
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
                          onClick={() => { setViewingExecutions(hook.id); setActiveTab('executions'); }}
                          className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded cursor-pointer"
                          title="View execution log"
                        >
                          <History className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setEditingHook(hook)}
                          className="p-1 text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded cursor-pointer"
                          title="Edit"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
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

      </>}

      <CreateHookModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['hooks'] })}
      />

      {editingHook && (
        <EditHookModal
          hook={editingHook}
          onClose={() => setEditingHook(null)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['hooks'] })}
        />
      )}
    </div>
  );
}
