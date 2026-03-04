'use client';

import { useState } from 'react';
import { X, Terminal } from 'lucide-react';
import { type Model, AVAILABLE_TOPICS } from '@/lib/types/models';

export interface EditModelModalProps {
  model: Model;
  onClose: () => void;
  onSave: (name: string, data: Record<string, unknown>) => Promise<void>;
  loading: boolean;
}

export function EditModelModal({ model, onClose, onSave, loading }: EditModelModalProps) {
  const cliAgent = model.metadata?.cliAgent || {};
  const [formData, setFormData] = useState({
    endpoint: model.endpoint || '',
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    topics: (model.topics || []).filter(t => AVAILABLE_TOPICS.some(at => at.value === t)),
    priority: model.priority,
    supportsVision: model.supportsVision,
    supportsTools: model.supportsTools,
    supportsStreaming: model.supportsStreaming,
    costPerInputToken: model.costPerInputToken,
    costPerOutputToken: model.costPerOutputToken,
    // CLI agent settings
    cliPermissionMode: cliAgent.permissionMode || '',
    cliAllowedTools: (cliAgent.allowedTools || []).join(', '),
    cliMaxBudgetUsd: cliAgent.maxBudgetUsd ?? '',
    cliMcpConfigPath: cliAgent.mcpConfigPath || '',
    cliExtraArgs: (cliAgent.extraArgs || []).join(' '),
  });
  const [error, setError] = useState('');

  const isCli = model.provider === 'cli';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const payload: Record<string, unknown> = {
        endpoint: formData.endpoint || undefined,
        contextWindow: formData.contextWindow,
        maxTokens: formData.maxTokens,
        topics: formData.topics,
        priority: formData.priority,
        supportsVision: formData.supportsVision,
        supportsTools: formData.supportsTools,
        supportsStreaming: formData.supportsStreaming,
        costPerInputToken: formData.costPerInputToken,
        costPerOutputToken: formData.costPerOutputToken,
      };

      // Include CLI agent settings in metadata
      if (isCli) {
        const cliAgentConfig: Record<string, unknown> = {};
        if (formData.cliPermissionMode) cliAgentConfig.permissionMode = formData.cliPermissionMode;
        if (formData.cliAllowedTools.trim()) {
          cliAgentConfig.allowedTools = formData.cliAllowedTools.split(',').map(t => t.trim()).filter(Boolean);
        }
        if (formData.cliMaxBudgetUsd !== '') {
          cliAgentConfig.maxBudgetUsd = Number(formData.cliMaxBudgetUsd);
        }
        if (formData.cliMcpConfigPath) cliAgentConfig.mcpConfigPath = formData.cliMcpConfigPath;
        if (formData.cliExtraArgs.trim()) {
          cliAgentConfig.extraArgs = formData.cliExtraArgs.split(/\s+/).filter(Boolean);
        }

        payload.metadata = {
          ...model.metadata,
          cliAgent: Object.keys(cliAgentConfig).length > 0 ? cliAgentConfig : undefined,
        };
      }

      await onSave(model.name, payload);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit Model</h2>
            <p className="text-sm text-gray-500">{model.name} <span className="font-mono text-xs">({model.provider}/{model.modelId})</span></p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded cursor-pointer">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {model.provider !== 'cli' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Endpoint URL</label>
              <input
                type="text"
                value={formData.endpoint}
                onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
                placeholder="Leave empty for default"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-sm"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Context Window</label>
              <input
                type="number"
                value={formData.contextWindow}
                onChange={(e) => setFormData({ ...formData, contextWindow: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Max Tokens</label>
              <input
                type="number"
                value={formData.maxTokens}
                onChange={(e) => setFormData({ ...formData, maxTokens: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Topics</label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Select which orchestrator roles can use this model</p>
              <div className="flex flex-wrap gap-2">
                {AVAILABLE_TOPICS.map((topic) => {
                  const selected = formData.topics.includes(topic.value);
                  return (
                    <button
                      key={topic.value}
                      type="button"
                      onClick={() => setFormData({
                        ...formData,
                        topics: selected
                          ? formData.topics.filter(t => t !== topic.value)
                          : [...formData.topics, topic.value],
                      })}
                      className={`px-3 py-1.5 rounded-lg text-sm cursor-pointer transition-colors ${
                        selected
                          ? 'bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300 ring-1 ring-primary-300 dark:ring-primary-700'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                      title={topic.description}
                    >
                      {topic.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {model.provider !== 'cli' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cost/1M Input Tokens</label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.costPerInputToken}
                  onChange={(e) => setFormData({ ...formData, costPerInputToken: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cost/1M Output Tokens</label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.costPerOutputToken}
                  onChange={(e) => setFormData({ ...formData, costPerOutputToken: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.supportsVision}
                onChange={(e) => setFormData({ ...formData, supportsVision: e.target.checked })}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">Vision</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.supportsTools}
                onChange={(e) => setFormData({ ...formData, supportsTools: e.target.checked })}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">Tools</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.supportsStreaming}
                onChange={(e) => setFormData({ ...formData, supportsStreaming: e.target.checked })}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">Streaming</span>
            </label>
          </div>

          {/* CLI Agent Settings */}
          {isCli && (
            <div className="border border-violet-200 dark:border-violet-800 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <Terminal className="w-4 h-4 text-violet-600" />
                <h3 className="text-sm font-semibold text-violet-900 dark:text-violet-300">CLI Agent Settings</h3>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                CLI models run as autonomous sub-agents with their own tools and agent loop.
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Permission Mode</label>
                <select
                  value={formData.cliPermissionMode}
                  onChange={(e) => setFormData({ ...formData, cliPermissionMode: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm"
                >
                  <option value="">Default</option>
                  <option value="bypassPermissions">Bypass Permissions (Claude)</option>
                  <option value="yolo">YOLO (Gemini)</option>
                  <option value="plan">Plan Only</option>
                  <option value="acceptEdits">Accept Edits (Claude)</option>
                  <option value="auto_edit">Auto Edit (Gemini)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Max Budget (USD per invocation)
                </label>
                <input
                  type="number"
                  step="0.10"
                  min="0"
                  value={formData.cliMaxBudgetUsd}
                  onChange={(e) => setFormData({ ...formData, cliMaxBudgetUsd: e.target.value })}
                  placeholder="No limit"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Claude Code only. Leave empty for no limit.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">MCP Config Path</label>
                <input
                  type="text"
                  value={formData.cliMcpConfigPath}
                  onChange={(e) => setFormData({ ...formData, cliMcpConfigPath: e.target.value })}
                  placeholder="/path/to/mcp-config.json"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Allowed Tools</label>
                <input
                  type="text"
                  value={formData.cliAllowedTools}
                  onChange={(e) => setFormData({ ...formData, cliAllowedTools: e.target.value })}
                  placeholder="Bash, Read, Edit, WebSearch"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Claude Code only. Comma-separated. Empty = all tools.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Extra CLI Arguments</label>
                <input
                  type="text"
                  value={formData.cliExtraArgs}
                  onChange={(e) => setFormData({ ...formData, cliExtraArgs: e.target.value })}
                  placeholder="--no-session-persistence --max-turns 10"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-sm"
                />
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
