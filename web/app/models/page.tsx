'use client';

import { useState, useEffect, useCallback } from 'react';
import { Cpu, Plus, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { type Model, type CLITool } from '@/lib/types/models';
import { AddModelModal } from '@/components/models/add-model-modal';
import { EditModelModal } from '@/components/models/edit-model-modal';
import { CLIStatusPanel } from '@/components/models/cli-status-panel';
import { ModelCard } from '@/components/models/model-card';

export default function ModelsPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [cliTools, setCLITools] = useState<CLITool[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchModels = useCallback(async () => {
    try {
      const data = await api.get<{ models: Model[] }>('/models');
      setModels(data.models || []);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCLIStatus = useCallback(async () => {
    try {
      const data = await api.get<{ tools: CLITool[] }>('/models/cli/status');
      setCLITools(data.tools || []);
    } catch {
      // CLI status is optional, don't show error
    }
  }, []);

  useEffect(() => {
    fetchModels();
    fetchCLIStatus();
  }, [fetchModels, fetchCLIStatus]);

  const handleAddModel = async (modelData: Record<string, unknown>) => {
    setActionLoading(true);
    try {
      await api.post('/models', modelData);
      await fetchModels();
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteModel = async (name: string) => {
    if (!confirm(`Delete model "${name}"?`)) return;

    setActionLoading(true);
    try {
      await api.delete(`/models/${encodeURIComponent(name)}`);
      await fetchModels();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveModel = async (name: string, data: Record<string, unknown>) => {
    setActionLoading(true);
    try {
      await api.patch(`/models/${encodeURIComponent(name)}`, data);
      await fetchModels();
    } finally {
      setActionLoading(false);
    }
  };

  const handleSetDefault = async (name: string) => {
    setActionLoading(true);
    try {
      await api.post(`/models/${encodeURIComponent(name)}/default`);
      await fetchModels();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleEnabled = async (model: Model) => {
    try {
      await api.patch(`/models/${encodeURIComponent(model.name)}`, {
        isEnabled: !model.isEnabled,
      });
      await fetchModels();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 animate-spin text-gray-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
            <Cpu className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Models</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Configure LLM models, providers, and CLI tools</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { fetchModels(); fetchCLIStatus(); }}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsModalOpen(true)}
            className="px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add Model
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 text-red-700 dark:text-red-300 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      <CLIStatusPanel tools={cliTools} registeredModels={models} onAdd={handleAddModel} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {models.length === 0 ? (
          <div className="col-span-full text-center py-8 text-gray-500">
            <Cpu className="w-12 h-12 mx-auto mb-3 text-gray-300" />
            <p>No models configured</p>
            <p className="text-sm mt-1">Click &quot;Add Model&quot; to configure your first model</p>
          </div>
        ) : (
          models.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              onSetDefault={handleSetDefault}
              onEdit={setEditingModel}
              onToggleEnabled={handleToggleEnabled}
              onDelete={handleDeleteModel}
            />
          ))
        )}
      </div>

      <AddModelModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAdd={handleAddModel}
        loading={actionLoading}
      />

      {editingModel && (
        <EditModelModal
          model={editingModel}
          onClose={() => setEditingModel(null)}
          onSave={handleSaveModel}
          loading={actionLoading}
        />
      )}
    </div>
  );
}
