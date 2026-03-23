'use client';

import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Webhook, Plus, ToggleLeft, ToggleRight, Trash2, Pencil, X, Loader2, Info, Lightbulb, Save, History, ChevronDown, ChevronUp, CheckCircle2, XCircle, Clock, Play } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { SchedulePicker, describeCron } from '@/components/schedule-picker';

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
  maxExecutions?: number | null;
  lastExecutedAt?: string;
  nextRunAt?: string;
  lastError?: string;
}

interface HookExecution {
  id: string;
  hookId?: string;
  recurringTaskId?: string;
  hookName?: string;
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
      <div className="flex items-center justify-center py-8 text-on-surface-variant">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading execution history...
      </div>
    );
  }

  if (executions.length === 0) {
    return (
      <div className="text-center py-8 text-on-surface-variant">
        <History className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p>No executions yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {executions.map((exec) => (
        <div key={exec.id} className="border border-outline-variant/10 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpanded(expanded === exec.id ? null : exec.id)}
            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[#20201f] text-left cursor-pointer"
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
                {(() => {
                  const name = exec.hookName || String((exec.triggerContext as Record<string, unknown>)?.hookName || '');
                  return name ? <span className="text-xs font-medium text-white">{name}</span> : null;
                })()}
                <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                  {exec.source === 'recurring_task' ? 'task' : exec.source}
                </span>
                {exec.triggerType && (
                  <span className="text-xs text-on-surface-variant">{exec.triggerType}</span>
                )}
                {exec.actionType && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/30 text-green-300">
                    {exec.actionType}
                  </span>
                )}
                {exec.durationMs !== undefined && (
                  <span className="text-xs text-on-surface-variant">{exec.durationMs}ms</span>
                )}
              </div>
              {exec.error && (
                <p className="text-xs text-red-500 truncate mt-0.5">{exec.error}</p>
              )}
            </div>
            <span className="text-xs text-on-surface-variant flex-shrink-0">
              {new Date(exec.createdAt).toLocaleString()}
            </span>
            {expanded === exec.id ? (
              <ChevronUp className="w-4 h-4 text-on-surface-variant flex-shrink-0" />
            ) : (
              <ChevronDown className="w-4 h-4 text-on-surface-variant flex-shrink-0" />
            )}
          </button>
          {expanded === exec.id && (
            <div className="px-3 py-2 border-t border-outline-variant/10 bg-[#131313] space-y-2">
              {exec.error && (
                <div>
                  <p className="text-xs font-medium text-error">Error</p>
                  <p className="text-xs text-red-500 font-mono whitespace-pre-wrap">{exec.error}</p>
                </div>
              )}
              {exec.result && (
                <div>
                  <p className="text-xs font-medium text-on-surface-variant">Result</p>
                  <pre className="text-xs text-on-surface-variant font-mono whitespace-pre-wrap overflow-x-auto max-h-40 overflow-y-auto">
                    {JSON.stringify(exec.result, null, 2)}
                  </pre>
                </div>
              )}
              {exec.triggerContext && (
                <div>
                  <p className="text-xs font-medium text-on-surface-variant">Trigger Context</p>
                  <pre className="text-xs text-on-surface-variant font-mono whitespace-pre-wrap overflow-x-auto max-h-40 overflow-y-auto">
                    {JSON.stringify(exec.triggerContext, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {(data?.total || 0) > executions.length && (
        <p className="text-xs text-center text-on-surface-variant py-1">
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
  const [webhookSecret, setWebhookSecret] = useState('');
  const [cronExpression, setCronExpression] = useState('');
  const [messagePattern, setMessagePattern] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');
  const [orchestrated, setOrchestrated] = useState(true);
  const [notifyOwner, setNotifyOwner] = useState(true);
  const [notifyChannels, setNotifyChannels] = useState('');
  const [notifyMessage, setNotifyMessage] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [runOnce, setRunOnce] = useState(false);
  const [userChannels, setUserChannels] = useState<{ channelType: string; channelUserName?: string }[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Fetch user's linked channels for the notify action
  useEffect(() => {
    if (!open) return;
    api.get<{ channelBindings?: { channelType: string; channelUserName?: string; isVerified: boolean }[] }>('/auth/me')
      .then(data => {
        const bindings = (data.channelBindings || []).filter(b => b.isVerified);
        setUserChannels(bindings);
      })
      .catch(() => {});
  }, [open]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setIsSubmitting(true);
    setError('');

    try {
      const triggerConfig: Record<string, unknown> = {};
      if (trigger === 'webhook') {
        triggerConfig.webhookPath = webhookPath;
        if (webhookSecret) triggerConfig.webhookSecret = webhookSecret;
      }
      if (trigger === 'schedule') triggerConfig.cronExpression = cronExpression;
      if (trigger === 'message_received' && messagePattern) triggerConfig.pattern = messagePattern;

      const actionConfig: Record<string, unknown> = {};
      if (action === 'spawn_agent') {
        actionConfig.agentPrompt = agentPrompt;
        actionConfig.orchestrated = orchestrated;
        actionConfig.notifyOwner = notifyOwner;
      }
      if (action === 'notify') {
        actionConfig.notifyOwner = notifyOwner;
        if (!notifyOwner && notifyChannels.trim()) {
          actionConfig.notifyChannels = notifyChannels.split(',').map(s => s.trim()).filter(Boolean);
        }
        actionConfig.notifyMessage = notifyMessage;
      }
      if (action === 'webhook') {
        actionConfig.webhookUrl = webhookUrl;
      }

      await api.post('/hooks', {
        name,
        description,
        trigger,
        triggerConfig,
        action,
        actionConfig,
        isEnabled: true,
        ...(runOnce ? { maxExecutions: 1 } : {}),
      });

      onCreated();
      onClose();
      // Reset form
      setName('');
      setDescription('');
      setTrigger('webhook');
      setAction('spawn_agent');
      setWebhookPath('');
      setWebhookSecret('');
      setCronExpression('');
      setMessagePattern('');
      setAgentPrompt('');
      setOrchestrated(true);
      setNotifyOwner(true);
      setNotifyChannels('');
      setNotifyMessage('');
      setWebhookUrl('');
    } catch (err) {
      setError((err as Error).message);
    }

    setIsSubmitting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#1a1a1a] rounded-[1rem] shadow-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-extrabold tracking-tighter text-white">Create Hook</h2>
          <button onClick={onClose} className="p-1 text-on-surface-variant hover:text-white cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Name & Description */}
          <div>
            <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
              placeholder="e.g., GitHub PR Review"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Description</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
              placeholder="What this hook does"
            />
          </div>

          {/* Trigger */}
          <div>
            <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Trigger</label>
            <select
              value={trigger}
              onChange={e => setTrigger(e.target.value)}
              className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
            >
              {TRIGGER_OPTIONS.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-on-surface-variant">
              {TRIGGER_OPTIONS.find(t => t.value === trigger)?.desc}
            </p>
          </div>

          {/* Trigger-specific config */}
          {trigger === 'webhook' && (
            <>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">
                  Webhook Path
                </label>
                <div className="flex items-center gap-1">
                  <span className="text-sm text-on-surface-variant">/api/webhooks/</span>
                  <input
                    type="text"
                    value={webhookPath}
                    onChange={e => setWebhookPath(e.target.value)}
                    className="flex-1 bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
                    placeholder="github"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">
                  Webhook Secret
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={webhookSecret}
                    onChange={e => setWebhookSecret(e.target.value)}
                    className="flex-1 bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm font-mono focus:ring-1 focus:ring-primary"
                    placeholder="Generate or enter a secret..."
                  />
                  <button
                    type="button"
                    onClick={() => setWebhookSecret(crypto.randomUUID().replace(/-/g, ''))}
                    className="px-3 py-2 text-xs font-medium bg-[#262626] text-white rounded-lg hover:bg-[#20201f] cursor-pointer whitespace-nowrap"
                  >
                    Generate
                  </button>
                </div>
                <p className="mt-1 text-xs text-on-surface-variant">Used to verify HMAC-SHA256 signatures (X-Hub-Signature-256). Required for GitHub/GitLab webhooks.</p>
              </div>
            </>
          )}

          {trigger === 'schedule' && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">
                  Schedule
                </label>
                <SchedulePicker value={cronExpression} onChange={setCronExpression} />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={runOnce}
                  onChange={e => setRunOnce(e.target.checked)}
                  className="rounded accent-primary"
                />
                <span className="text-sm text-white">Run once (single event, auto-disables after execution)</span>
              </label>
            </div>
          )}

          {trigger === 'message_received' && (
            <div>
              <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Message Pattern (optional regex)</label>
              <input
                type="text"
                value={messagePattern}
                onChange={e => setMessagePattern(e.target.value)}
                className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm font-mono focus:ring-1 focus:ring-primary"
                placeholder=".*deploy.*"
              />
            </div>
          )}

          {/* Action */}
          <div>
            <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Action</label>
            <select
              value={action}
              onChange={e => setAction(e.target.value)}
              className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
            >
              {ACTION_OPTIONS.map(a => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-on-surface-variant">
              {ACTION_OPTIONS.find(a => a.value === action)?.desc}
            </p>
          </div>

          {/* Action-specific config */}
          {action === 'spawn_agent' && (
            <>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">
                  Agent Prompt
                </label>
                <textarea
                  value={agentPrompt}
                  onChange={e => setAgentPrompt(e.target.value)}
                  rows={3}
                  className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
                  placeholder="Review the changes in this PR against our code guidelines..."
                />
                <p className="mt-1 text-xs text-on-surface-variant">
                  Use {'{{webhook.body.field}}'} for template variables
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm text-white">
                <input
                  type="checkbox"
                  checked={orchestrated}
                  onChange={e => setOrchestrated(e.target.checked)}
                  className="rounded"
                />
                Route through orchestrator (recommended — enables multi-stage pipelines)
              </label>
              <label className="flex items-center gap-2 text-sm text-white">
                <input
                  type="checkbox"
                  checked={notifyOwner}
                  onChange={e => setNotifyOwner(e.target.checked)}
                  className="rounded"
                />
                Send result to my linked channels
              </label>
            </>
          )}

          {action === 'notify' && (
            <>
              <div>
                <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifyOwner}
                    onChange={e => setNotifyOwner(e.target.checked)}
                    className="rounded"
                  />
                  Notify me on my linked channels
                </label>
                {notifyOwner && userChannels.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {userChannels.map((ch, i) => (
                      <span key={i} className="inline-flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary text-xs rounded-md border border-primary/20">
                        {ch.channelType}{ch.channelUserName ? `: ${ch.channelUserName}` : ''}
                      </span>
                    ))}
                  </div>
                )}
                {notifyOwner && userChannels.length === 0 && (
                  <p className="mt-1 text-xs text-amber-400">No channels linked. Go to Settings → Channels to link Telegram, Slack, etc.</p>
                )}
              </div>
              {!notifyOwner && (
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Channels (advanced)</label>
                  <input
                    type="text"
                    value={notifyChannels}
                    onChange={e => setNotifyChannels(e.target.value)}
                    className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
                    placeholder="telegram:123456, slack:general"
                  />
                  <p className="mt-1 text-xs text-on-surface-variant">Comma-separated, format: type:channelId</p>
                </div>
              )}
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Message Template</label>
                <textarea
                  value={notifyMessage}
                  onChange={e => setNotifyMessage(e.target.value)}
                  rows={3}
                  className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
                  placeholder="{{webhook.body.action}} on {{webhook.body.repository.full_name}}"
                />
                <p className="mt-1 text-xs text-on-surface-variant">Use {'{{webhook.body.field}}'} for template variables</p>
              </div>
            </>
          )}

          {action === 'webhook' && (
            <div>
              <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Outgoing Webhook URL</label>
              <input
                type="text"
                value={webhookUrl}
                onChange={e => setWebhookUrl(e.target.value)}
                className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
                placeholder="https://example.com/webhook"
              />
            </div>
          )}

          {error && (
            <p className="text-sm text-error">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-on-surface-variant hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !name.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-[#0e0e0e] cursor-pointer rounded-lg hover:bg-primary-container disabled:opacity-50 text-sm"
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
  const [webhookSecret, setWebhookSecret] = useState((hook.triggerConfig?.webhookSecret as string) || '');
  const [cronExpression, setCronExpression] = useState((hook.triggerConfig?.cronExpression as string) || '');
  const [messagePattern, setMessagePattern] = useState((hook.triggerConfig?.pattern as string) || '');

  // Action config — spawn_agent
  const [agentPrompt, setAgentPrompt] = useState((hook.actionConfig?.agentPrompt as string) || '');
  const [orchestrated, setOrchestrated] = useState(Boolean(hook.actionConfig?.orchestrated));
  const [agentTopic, setAgentTopic] = useState((hook.actionConfig?.agentTopic as string) || '');
  const [agentModel, setAgentModel] = useState((hook.actionConfig?.agentModel as string) || '');

  // Action config — notify
  const [notifyOwner, setNotifyOwner] = useState(hook.actionConfig?.notifyOwner !== false);
  const [notifyChannels, setNotifyChannels] = useState((hook.actionConfig?.notifyChannels as string[] || []).join(', '));
  const [notifyMessage, setNotifyMessage] = useState((hook.actionConfig?.notifyMessage as string) || '');
  const [userChannels, setUserChannels] = useState<{ channelType: string; channelUserName?: string }[]>([]);

  // Action config — outgoing webhook
  const [webhookUrl, setWebhookUrl] = useState((hook.actionConfig?.webhookUrl as string) || '');
  const [webhookMethod, setWebhookMethod] = useState((hook.actionConfig?.webhookMethod as string) || 'POST');
  const [webhookBody, setWebhookBody] = useState((hook.actionConfig?.webhookBody as string) || '');

  // Action config — n8n_workflow
  const [workflowId, setWorkflowId] = useState((hook.actionConfig?.workflowId as string) || '');

  // Action config — execute_tool (tool)
  const [toolId, setToolId] = useState((hook.actionConfig?.toolId as string) || '');
  const [toolAction, setToolAction] = useState((hook.actionConfig?.toolAction as string) || '');

  const [runOnce, setRunOnce] = useState(hook.maxExecutions === 1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Fetch user's linked channels
  useEffect(() => {
    api.get<{ channelBindings?: { channelType: string; channelUserName?: string; isVerified: boolean }[] }>('/auth/me')
      .then(data => {
        const bindings = (data.channelBindings || []).filter(b => b.isVerified);
        setUserChannels(bindings);
      })
      .catch(() => {});
  }, []);

  const buildTriggerConfig = (): Record<string, unknown> => {
    const cfg: Record<string, unknown> = {};
    if (trigger === 'webhook') {
      cfg.webhookPath = webhookPath;
      if (webhookSecret) cfg.webhookSecret = webhookSecret;
    }
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
        cfg.notifyOwner = notifyOwner;
        if (agentTopic) cfg.agentTopic = agentTopic;
        if (agentModel) cfg.agentModel = agentModel;
        break;
      case 'notify':
        cfg.notifyOwner = notifyOwner;
        if (!notifyOwner && notifyChannels.trim()) {
          cfg.notifyChannels = notifyChannels.split(',').map(s => s.trim()).filter(Boolean);
        }
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
        maxExecutions: runOnce ? 1 : null,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
    setIsSubmitting(false);
  };

  const inputCls = 'w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#1a1a1a] rounded-[1rem] shadow-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-extrabold tracking-tighter text-white">Edit Hook</h2>
          <button onClick={onClose} className="p-1 text-on-surface-variant hover:text-white cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Name & Description */}
          <div>
            <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)} className={inputCls} />
          </div>

          {/* Trigger (read-only label + config) */}
          <div>
            <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Trigger</label>
            <div className="bg-[#262626] border-none rounded-md py-3 px-4 text-sm text-white">
              {TRIGGER_OPTIONS.find(t => t.value === trigger)?.label || trigger}
            </div>
            <p className="mt-1 text-xs text-on-surface-variant">
              {TRIGGER_OPTIONS.find(t => t.value === trigger)?.desc}
            </p>
          </div>

          {/* Trigger-specific config */}
          {trigger === 'webhook' && (
            <>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Webhook Path</label>
                <div className="flex items-center gap-1">
                  <span className="text-sm text-on-surface-variant">/api/webhooks/</span>
                  <input type="text" value={webhookPath} onChange={e => setWebhookPath(e.target.value)} className={'flex-1 ' + inputCls.replace('w-full ', '')} placeholder="github" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Webhook Secret</label>
                <div className="flex items-center gap-2">
                  <input type="text" value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)} className={inputCls + ' font-mono'} placeholder="Enter or generate a secret..." />
                  <button type="button" onClick={() => setWebhookSecret(crypto.randomUUID().replace(/-/g, ''))} className="px-3 py-2 text-xs font-medium bg-[#262626] text-white rounded-lg hover:bg-[#20201f] cursor-pointer whitespace-nowrap">
                    Generate
                  </button>
                </div>
                <p className="mt-1 text-xs text-on-surface-variant">HMAC-SHA256 secret for X-Hub-Signature-256 verification</p>
              </div>
            </>
          )}
          {trigger === 'schedule' && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Schedule</label>
                <SchedulePicker value={cronExpression} onChange={setCronExpression} />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={runOnce}
                  onChange={e => setRunOnce(e.target.checked)}
                  className="rounded accent-primary"
                />
                <span className="text-sm text-white">Run once (single event, auto-disables after execution)</span>
              </label>
            </div>
          )}
          {trigger === 'message_received' && (
            <div>
              <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Message Pattern (optional regex)</label>
              <input type="text" value={messagePattern} onChange={e => setMessagePattern(e.target.value)} className={inputCls + ' font-mono'} placeholder=".*deploy.*" />
            </div>
          )}

          {/* Action (read-only label + config) */}
          <div>
            <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Action</label>
            <div className="bg-[#262626] border-none rounded-md py-3 px-4 text-sm text-white">
              {ACTION_OPTIONS.find(a => a.value === action)?.label || action}
            </div>
            <p className="mt-1 text-xs text-on-surface-variant">
              {ACTION_OPTIONS.find(a => a.value === action)?.desc}
            </p>
          </div>

          {/* Action-specific config */}
          {action === 'spawn_agent' && (
            <>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Agent Prompt</label>
                <textarea value={agentPrompt} onChange={e => setAgentPrompt(e.target.value)} rows={3} className={inputCls} placeholder="Review the changes..." />
                <p className="mt-1 text-xs text-on-surface-variant">Use {'{{webhook.body.field}}'} for template variables</p>
              </div>
              <label className="flex items-center gap-2 text-sm text-white">
                <input type="checkbox" checked={orchestrated} onChange={e => setOrchestrated(e.target.checked)} className="rounded" />
                Route through orchestrator
              </label>
              <label className="flex items-center gap-2 text-sm text-white">
                <input type="checkbox" checked={notifyOwner} onChange={e => setNotifyOwner(e.target.checked)} className="rounded" />
                Send result to my linked channels
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Topic (optional)</label>
                  <input type="text" value={agentTopic} onChange={e => setAgentTopic(e.target.value)} className={inputCls} placeholder="coding" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Model (optional)</label>
                  <input type="text" value={agentModel} onChange={e => setAgentModel(e.target.value)} className={inputCls} placeholder="default" />
                </div>
              </div>
            </>
          )}

          {action === 'notify' && (
            <>
              <div>
                <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
                  <input type="checkbox" checked={notifyOwner} onChange={e => setNotifyOwner(e.target.checked)} className="rounded" />
                  Notify me on my linked channels
                </label>
                {notifyOwner && userChannels.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {userChannels.map((ch, i) => (
                      <span key={i} className="inline-flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary text-xs rounded-md border border-primary/20">
                        {ch.channelType}{ch.channelUserName ? `: ${ch.channelUserName}` : ''}
                      </span>
                    ))}
                  </div>
                )}
                {notifyOwner && userChannels.length === 0 && (
                  <p className="mt-1 text-xs text-amber-400">No channels linked. Go to Settings → Channels to link Telegram, Slack, etc.</p>
                )}
              </div>
              {!notifyOwner && (
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Channels (advanced)</label>
                  <input type="text" value={notifyChannels} onChange={e => setNotifyChannels(e.target.value)} className={inputCls} placeholder="telegram:123456, slack:general" />
                  <p className="mt-1 text-xs text-on-surface-variant">Comma-separated, format: type:channelId</p>
                </div>
              )}
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Message Template</label>
                <textarea value={notifyMessage} onChange={e => setNotifyMessage(e.target.value)} rows={2} className={inputCls} placeholder="Hook triggered: {{event.type}}" />
              </div>
            </>
          )}

          {action === 'webhook' && (
            <>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Webhook URL</label>
                <input type="text" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} className={inputCls} placeholder="https://example.com/webhook" />
              </div>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">HTTP Method</label>
                <select value={webhookMethod} onChange={e => setWebhookMethod(e.target.value)} className={inputCls}>
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Body Template (optional)</label>
                <textarea value={webhookBody} onChange={e => setWebhookBody(e.target.value)} rows={3} className={inputCls + ' font-mono'} placeholder='{"event": "{{event.type}}"}' />
              </div>
            </>
          )}

          {action === 'n8n_workflow' && (
            <div>
              <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Workflow ID</label>
              <input type="text" value={workflowId} onChange={e => setWorkflowId(e.target.value)} className={inputCls} placeholder="1" />
            </div>
          )}

          {action === 'execute_tool' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Tool ID</label>
                <input type="text" value={toolId} onChange={e => setToolId(e.target.value)} className={inputCls} placeholder="shell" />
              </div>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Tool Action</label>
                <input type="text" value={toolAction} onChange={e => setToolAction(e.target.value)} className={inputCls} placeholder="execute" />
              </div>
            </div>
          )}

          {error && <p className="text-sm text-error">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-on-surface-variant hover:text-white cursor-pointer">
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !name.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-[#0e0e0e] cursor-pointer rounded-lg hover:bg-primary-container disabled:opacity-50 text-sm"
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
        const res = await api.get<{ suggestions: Array<{ id: string; name: string; description: string; category: string; integration: string }> }>('/hooks/suggestions');
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
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Webhook className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-4xl font-extrabold tracking-tighter text-white">Hooks & Tasks</h1>
            <p className="text-on-surface-variant">Event-driven automation. Create hooks that trigger on messages, agent events, schedules, or incoming webhooks.</p>
          </div>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-primary text-[#0e0e0e] cursor-pointer rounded-lg hover:bg-primary-container flex items-center gap-2 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Create Hook
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-outline-variant/10">
        {(['hooks', 'tasks', 'executions'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); setViewingExecutions(null); }}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px cursor-pointer',
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-on-surface-variant hover:text-white'
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
        <div className="bg-[#1a1a1a] rounded-[1rem] p-4">
          <h2 className="text-sm font-semibold text-white mb-3">
            {viewingExecutions ? 'Hook Executions' : 'All Recent Executions'}
            {viewingExecutions && (
              <button
                onClick={() => setViewingExecutions(null)}
                className="ml-2 text-xs text-primary hover:underline cursor-pointer"
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
          {/* Suggested automations */}
          {suggestions.length > 0 && (() => {
            const categoryLabels: Record<string, string> = {
              'daily-briefing': 'Daily Briefings',
              'email': 'Email Management',
              'calendar': 'Calendar',
              'developer': 'Developer Workflows',
              'monitoring': 'System Monitoring',
              'productivity': 'Productivity',
            };
            const categoryOrder = ['daily-briefing', 'email', 'calendar', 'developer', 'monitoring', 'productivity'];
            const grouped = suggestions.reduce<Record<string, typeof suggestions>>((acc, s) => {
              const cat = (s as any).category || 'productivity';
              if (!acc[cat]) acc[cat] = [];
              acc[cat].push(s);
              return acc;
            }, {});

            return (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Lightbulb className="w-5 h-5 text-primary" />
                  <span className="text-lg font-bold text-white">Ready-to-Use Automations</span>
                  <span className="text-xs text-on-surface-variant">One click to add. Enable when ready.</span>
                </div>
                {categoryOrder.filter(cat => grouped[cat]?.length).map(cat => (
                  <div key={cat}>
                    <h3 className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-2 px-1">{categoryLabels[cat] || cat}</h3>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {grouped[cat].map((s) => (
                        <div key={s.id} className="bg-[#1a1a1a] rounded-lg p-3 border border-outline-variant/10 hover:border-primary/20 transition-colors">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-white">{s.name}</p>
                              <p className="text-xs text-on-surface-variant mt-0.5 line-clamp-2">{s.description}</p>
                              <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-[#262626] text-on-surface-variant">{s.integration}</span>
                            </div>
                            <button
                              onClick={() => applySuggestion(s.id)}
                              className="text-xs px-3 py-1 bg-primary text-[#0e0e0e] rounded-full font-bold hover:bg-primary-container flex-shrink-0 cursor-pointer transition-colors"
                            >
                              Add
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}

          <div className="bg-[#1a1a1a] rounded-[1rem]">
            {isLoading ? (
              <div className="p-8 text-center text-on-surface-variant">
                <Loader2 className="w-5 h-5 animate-spin inline mr-2" />Loading...
              </div>
            ) : hooks.filter(h => h.trigger === 'schedule').length === 0 ? (
              <div className="p-8 text-center text-on-surface-variant">
                <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>No scheduled tasks</p>
                <p className="text-sm mt-1">Create a hook with &quot;Schedule&quot; trigger to add a recurring task</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-[#131313]">
                  <tr>
                    <th className="text-left px-4 py-2 font-bold text-on-surface-variant uppercase">Name</th>
                    <th className="text-left px-4 py-2 font-bold text-on-surface-variant uppercase">Schedule</th>
                    <th className="text-left px-4 py-2 font-bold text-on-surface-variant uppercase">Action</th>
                    <th className="text-left px-4 py-2 font-bold text-on-surface-variant uppercase">Last Run</th>
                    <th className="text-left px-4 py-2 font-bold text-on-surface-variant uppercase">Next Run</th>
                    <th className="text-left px-4 py-2 font-bold text-on-surface-variant uppercase">Runs</th>
                    <th className="text-left px-4 py-2 font-bold text-on-surface-variant uppercase">Status</th>
                    <th className="text-right px-4 py-2 font-bold text-on-surface-variant uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/10">
                  {hooks.filter(h => h.trigger === 'schedule').map((hook) => (
                    <tr key={hook.id} className="hover:bg-[#20201f]">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{hook.name}</div>
                        {hook.description && <div className="text-xs text-on-surface-variant mt-0.5">{hook.description}</div>}
                        {hook.lastError && <div className="text-xs text-red-500 mt-0.5">{hook.lastError}</div>}
                      </td>
                      <td className="px-4 py-3 text-xs text-on-surface-variant">
                        <div>{describeCron((hook.triggerConfig?.cronExpression as string) || '')}</div>
                        <div className="font-mono text-[10px] text-on-surface-variant mt-0.5">{(hook.triggerConfig?.cronExpression as string) || '—'}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 bg-green-900/30 text-green-300 text-xs rounded">
                          {hook.action}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-on-surface-variant">
                        {hook.lastExecutedAt ? new Date(hook.lastExecutedAt).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-on-surface-variant">
                        {hook.nextRunAt ? new Date(hook.nextRunAt).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-on-surface-variant">{hook.executionCount}</td>
                      <td className="px-4 py-3">
                        <span className={cn(
                          'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                          hook.isEnabled && !hook.lastError ? 'bg-green-900/20 text-green-400' :
                          hook.lastError ? 'bg-error-dim/20 text-error' :
                          'bg-[#262626] text-on-surface-variant',
                        )}>
                          {!hook.isEnabled ? 'paused' : hook.lastError ? 'error' : 'active'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex gap-1 justify-end">
                          <button
                            onClick={() => { setViewingExecutions(hook.id); setActiveTab('executions'); }}
                            className="p-1 text-on-surface-variant hover:text-primary hover:bg-primary/10 rounded cursor-pointer"
                            title="Execution log"
                          >
                            <History className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setEditingHook(hook)}
                            className="p-1 text-on-surface-variant hover:text-primary hover:bg-primary/10 rounded cursor-pointer"
                            title="Edit"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleToggle(hook.id, hook.isEnabled)}
                            className="p-1 text-on-surface-variant hover:text-white rounded cursor-pointer"
                            title={hook.isEnabled ? 'Pause' : 'Resume'}
                          >
                            {hook.isEnabled ? <ToggleRight className="w-5 h-5 text-green-500" /> : <ToggleLeft className="w-5 h-5" />}
                          </button>
                          <button
                            onClick={() => handleDelete(hook.id)}
                            className="p-1 text-error hover:text-error hover:bg-error-dim/10 rounded cursor-pointer"
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
      <div className="bg-[#1a1a1a] rounded-[1rem]">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-outline-variant/10">
                <th className="px-4 py-3 text-left text-sm font-bold text-on-surface-variant uppercase">Name</th>
                <th className="px-4 py-3 text-left text-sm font-bold text-on-surface-variant uppercase">Trigger</th>
                <th className="px-4 py-3 text-left text-sm font-bold text-on-surface-variant uppercase">Action</th>
                <th className="px-4 py-3 text-left text-sm font-bold text-on-surface-variant uppercase">Executions</th>
                <th className="px-4 py-3 text-left text-sm font-bold text-on-surface-variant uppercase">Status</th>
                <th className="px-4 py-3 text-left text-sm font-bold text-on-surface-variant uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-on-surface-variant">
                    <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                    Loading...
                  </td>
                </tr>
              ) : hooks.filter(h => h.trigger !== 'schedule').length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-on-surface-variant">
                    <div className="flex flex-col items-center gap-2">
                      <Webhook className="w-8 h-8 text-on-surface-variant" />
                      <p>No event hooks configured</p>
                      <p className="text-sm">Create a hook to automate actions based on events</p>
                    </div>
                  </td>
                </tr>
              ) : (
                hooks.filter(h => h.trigger !== 'schedule').map((hook) => (
                  <tr key={hook.id} className="border-b border-outline-variant/10 hover:bg-[#20201f]">
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-white">{hook.name}</p>
                        {hook.description && (
                          <p className="text-sm text-on-surface-variant">{hook.description}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-1 bg-primary/10 text-primary text-xs rounded">{hook.trigger}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-1 bg-green-900/30 text-green-300 text-xs rounded">
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
                        className="text-on-surface-variant hover:text-white cursor-pointer"
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
                          className="p-1 text-on-surface-variant hover:text-primary hover:bg-primary/10 rounded cursor-pointer"
                          title="View execution log"
                        >
                          <History className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setEditingHook(hook)}
                          className="p-1 text-on-surface-variant hover:text-primary hover:bg-primary/10 rounded cursor-pointer"
                          title="Edit"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(hook.id)}
                          className="p-1 text-error hover:text-error hover:bg-error-dim/10 rounded cursor-pointer"
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
