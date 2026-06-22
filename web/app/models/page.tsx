'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { AddModelModal } from '@/components/models/add-model-modal';
import { CLIStatusPanel } from '@/components/models/cli-status-panel';
import { EditModelModal } from '@/components/models/edit-model-modal';
import { ModelCard } from '@/components/models/model-card';
import { RecommendedModelsPanel } from '@/components/models/recommended-models-panel';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import type { CLITool, Model } from '@/lib/types/models';

export default function ModelsPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');

  const {
    data: modelsData,
    isLoading: loading,
    error: modelsError,
    refetch: refetchModels,
  } = useQuery({
    queryKey: ['models'],
    queryFn: () => api.get<{ models: Model[] }>('/models'),
  });
  const models = modelsData?.models ?? [];

  const { data: cliData, refetch: refetchCLIStatus } = useQuery({
    queryKey: ['models', 'cli-status'],
    queryFn: () => api.get<{ tools: CLITool[] }>('/models/cli/status'),
  });
  const cliTools = cliData?.tools ?? [];

  // Re-fetch the models list; returns a promise so mutation handlers can await it.
  const fetchModels = useCallback(async () => { await refetchModels(); }, [refetchModels]);
  const fetchCLIStatus = useCallback(() => { refetchCLIStatus(); }, [refetchCLIStatus]);

  // Surface either a load failure or an action error; the local `error` (when
  // set by a mutation) is independently dismissable.
  const displayError = error || (modelsError ? (modelsError as Error).message : '');

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
      <PageHeader
        title="models"
        description="Configure AI model providers — endpoints, capabilities, and cost. Assign which topics each model serves on the Topics page."
        actions={
          <>
            <button
              onClick={() => { fetchModels(); fetchCLIStatus(); }}
              className="px-3 py-2 border border-outline-variant/10 text-on-surface-variant rounded-full hover:bg-surface-container-high cursor-pointer"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={() => setIsModalOpen(true)}
              className="px-4 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary cursor-pointer rounded-full hover:opacity-90 flex items-center gap-2 font-medium"
            >
              <Plus className="w-4 h-4" />
              Add Model
            </button>
          </>
        }
      />

      {displayError && (
        <div className="bg-error/10 border border-error/20 rounded-xs px-4 py-3 text-error text-sm">
          {displayError}
          <button onClick={() => setError('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      <RecommendedModelsPanel onInstalled={fetchModels} />

      <CLIStatusPanel
        tools={cliTools}
        registeredModels={models}
        onAdd={handleAddModel}
        onUpdate={async (id, patch) => {
          const m = models.find(mm => mm.id === id);
          if (!m) return;
          await handleSaveModel(m.name, patch);
        }}
      />

      <div className="stagger grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {models.length === 0 ? (
          <div className="col-span-full text-center py-8 text-on-surface-variant">
            <p aria-hidden className="text-2xl text-outline-variant font-mono mb-3">[ ]</p>
            <p>no models configured</p>
            <p className="text-sm mt-1">Click &quot;Add Model&quot; to register an LLM provider, then assign it to topics on the Topics page for automatic routing.</p>
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
