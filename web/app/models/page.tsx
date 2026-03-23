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
        <RefreshCw className="w-6 h-6 animate-spin text-on-surface-variant" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[1rem] bg-primary/10 flex items-center justify-center">
            <Cpu className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-4xl lg:text-5xl font-extrabold tracking-tighter text-white">Models</h1>
            <p className="text-on-surface-variant">Configure AI model providers and routing. Each model can be assigned to specific topics like coding, research, or orchestration.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { fetchModels(); fetchCLIStatus(); }}
            className="px-3 py-2 border border-outline-variant/10 text-on-surface-variant rounded-full hover:bg-surface-container-high cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsModalOpen(true)}
            className="px-4 py-2 bg-gradient-to-r from-primary to-primary-container text-on-primary cursor-pointer rounded-full hover:opacity-90 flex items-center gap-2 font-medium"
          >
            <Plus className="w-4 h-4" />
            Add Model
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 rounded-[1rem] px-4 py-3 text-error text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      <CLIStatusPanel tools={cliTools} registeredModels={models} onAdd={handleAddModel} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {models.length === 0 ? (
          <div className="col-span-full text-center py-8 text-on-surface-variant">
            <Cpu className="w-12 h-12 mx-auto mb-3 text-outline-variant" />
            <p>No models configured</p>
            <p className="text-sm mt-1">Click &quot;Add Model&quot; to register an LLM provider and assign it to topics for automatic routing.</p>
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
