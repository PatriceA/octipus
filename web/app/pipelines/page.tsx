'use client';

import {
  ChevronDown,
  ChevronUp,
  GitBranch,
  GripVertical,
  List,
  Network,
  Pencil,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PipelineGraph, validatePipelineStages } from '@/components/pipeline-graph';
import { reorderStages } from '../../../src/core/orchestrator/pipeline-validation';
import { api } from '@/lib/api';
import { AVAILABLE_TOPICS } from '@/lib/types/models';

interface PipelineStep {
  name: string;
  description?: string;
  topic: string;
  skillIds?: string[];
  requiresApproval?: boolean;
  promptTemplate?: string;
  stageType?: 'standard' | 'qa_validation';
  maxRetries?: number;
  retryTargetStage?: number;
}

interface PipelineTemplate {
  id: string;
  userId: string;
  name: string;
  description?: string;
  steps: PipelineStep[];
  createdAt: string;
  updatedAt: string;
}


export default function PipelinesPage() {
  const [templates, setTemplates] = useState<PipelineTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<PipelineTemplate | null>(null);

  const fetchTemplates = useCallback(async () => {
    try {
      const data = await api.get<{ templates: PipelineTemplate[] }>('/pipelines/templates');
      setTemplates(data?.templates ?? []);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this pipeline template?')) return;
    try {
      await api.delete(`/pipelines/templates/${id}`);
      setTemplates(prev => prev.filter(t => t.id !== id));
    } catch {
      // Ignore
    }
  };

  const handleEdit = (template: PipelineTemplate) => {
    setEditingTemplate(template);
    setShowEditor(true);
  };

  const handleCreate = () => {
    setEditingTemplate(null);
    setShowEditor(true);
  };

  const handleSave = async (data: { name: string; description?: string; steps: PipelineStep[] }) => {
    try {
      if (editingTemplate) {
        const updated = await api.put<PipelineTemplate>(`/pipelines/templates/${editingTemplate.id}`, data);
        setTemplates(prev => prev.map(t => t.id === editingTemplate.id ? updated : t));
      } else {
        const created = await api.post<PipelineTemplate>('/pipelines/templates', data);
        setTemplates(prev => [created, ...prev]);
      }
      setShowEditor(false);
      setEditingTemplate(null);
    } catch {
      // Ignore
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xs bg-primary/10 flex items-center justify-center">
            <GitBranch className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-4xl lg:text-5xl font-extrabold tracking-tighter text-white">Pipelines</h1>
            <p className="text-on-surface-variant">Multi-stage agent workflows. Chain specialist agents in sequence with approval gates and automatic QA retries.</p>
          </div>
        </div>
        <button
          onClick={handleCreate}
          className="flex items-center gap-2 px-4 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary cursor-pointer rounded-full hover:opacity-90 text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          New Template
        </button>
      </div>

      {/* Template list */}
      {templates.length === 0 ? (
        <div className="text-center py-16 bg-surface-container rounded-xs border border-outline-variant/10">
          <GitBranch className="w-12 h-12 mx-auto text-on-surface-variant mb-4" />
          <h3 className="text-lg font-medium text-white mb-2">No pipeline templates</h3>
          <p className="text-sm text-on-surface-variant mb-4">
            Create a template to chain multiple specialist agents in sequence. Each step can have its own topic, prompt, and approval gate.
          </p>
          <button
            onClick={handleCreate}
            className="inline-flex items-center gap-2 px-4 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary cursor-pointer rounded-full hover:opacity-90 text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Create Template
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {templates.map(template => (
            <TemplateCard
              key={template.id}
              template={template}
              onEdit={() => handleEdit(template)}
              onDelete={() => handleDelete(template.id)}
            />
          ))}
        </div>
      )}

      {/* Editor modal */}
      {showEditor && (
        <TemplateEditor
          template={editingTemplate}
          onSave={handleSave}
          onClose={() => { setShowEditor(false); setEditingTemplate(null); }}
        />
      )}
    </div>
  );
}

function TemplateCard({
  template,
  onEdit,
  onDelete,
}: {
  template: PipelineTemplate;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<'list' | 'graph'>('list');

  return (
    <div className="bg-surface-container rounded-xs border border-outline-variant/10 p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary" />
            <h3 className="font-medium text-white">{template.name}</h3>
            <span className="text-xs bg-surface-container-high text-on-surface-variant px-2 py-0.5 rounded">
              {template.steps.length} step{template.steps.length !== 1 ? 's' : ''}
            </span>
          </div>
          {template.description && (
            <p className="text-sm text-on-surface-variant mt-1">{template.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {expanded && (
            <div className="flex items-center bg-surface-container-high rounded-full p-0.5 mr-1">
              <button
                onClick={() => setView('list')}
                title="List view"
                className={`p-1 rounded-full cursor-pointer ${view === 'list' ? 'bg-primary/20 text-primary' : 'text-on-surface-variant hover:text-white'}`}
              >
                <List className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setView('graph')}
                title="Graph view"
                className={`p-1 rounded-full cursor-pointer ${view === 'graph' ? 'bg-primary/20 text-primary' : 'text-on-surface-variant hover:text-white'}`}
              >
                <Network className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1.5 text-on-surface-variant hover:text-white rounded cursor-pointer"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          <button
            onClick={onEdit}
            className="p-1.5 text-on-surface-variant hover:text-primary rounded cursor-pointer"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 text-on-surface-variant hover:text-error rounded cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Steps preview — list or graph */}
      {expanded && template.steps.length > 0 && (
        <div className="mt-4 border-t border-outline-variant/10 pt-3">
          {view === 'graph' ? (
            <PipelineGraph steps={template.steps} />
          ) : (
            <div className="space-y-2">
              {template.steps.map((step, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 text-sm pl-2"
                >
                  <span className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium">
                    {i + 1}
                  </span>
                  <span className="font-medium text-white">{step.name}</span>
                  <span className="text-xs bg-surface-container-high text-on-surface-variant px-1.5 py-0.5 rounded font-mono">
                    {step.topic}
                  </span>
                  {step.requiresApproval && (
                    <span title="Requires approval">
                      <Shield className="w-3.5 h-3.5 text-orange-500" />
                    </span>
                  )}
                  {(step as any).stageType === 'qa_validation' && (
                    <span title={`QA validation (retries step ${((step as any).retryTargetStage ?? 0) + 1}, max ${(step as any).maxRetries ?? 3})`}>
                      <RotateCcw className="w-3.5 h-3.5 text-blue-400" />
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TemplateEditor({
  template,
  onSave,
  onClose,
}: {
  template: PipelineTemplate | null;
  onSave: (data: { name: string; description?: string; steps: PipelineStep[] }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [steps, setSteps] = useState<PipelineStep[]>(template?.steps ?? []);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [view, setView] = useState<'list' | 'graph'>('list');
  const [errors, setErrors] = useState<string[]>([]);

  const addStep = () => {
    setSteps(prev => [
      ...prev,
      { name: '', topic: 'general', requiresApproval: false },
    ]);
    setExpandedStep(steps.length);
  };

  /**
   * Insert a stage after `afterIndex` (use -1 to prepend). Re-targets
   * any QA `retryTargetStage` that pointed to a later index so retries
   * keep firing the right stage post-shift.
   */
  const insertAfter = (afterIndex: number) => {
    const insertAt = afterIndex + 1;
    const newStep: PipelineStep = { name: '', topic: 'general', requiresApproval: false };
    setSteps(prev => {
      const next = [...prev];
      next.splice(insertAt, 0, newStep);
      // Shift retry targets that pointed to a later stage.
      return next.map((s, i) => {
        if (i === insertAt) return s;
        if (typeof s.retryTargetStage === 'number' && s.retryTargetStage >= insertAt) {
          return { ...s, retryTargetStage: s.retryTargetStage + 1 };
        }
        return s;
      });
    });
    setExpandedStep(insertAt);
    setView('list'); // jump to list so the user can fill in the new stage's fields
  };

  /**
   * Delete a stage and re-base every QA `retryTargetStage` that pointed
   * to it or to a later stage. Targets that pointed to the deleted stage
   * are cleared so the consumer must pick a valid earlier stage on the
   * next save (validatePipelineStages will surface this).
   */
  const deleteStep = (index: number) => {
    setSteps(prev => {
      const next = prev.filter((_, i) => i !== index);
      return next.map((s) => {
        if (typeof s.retryTargetStage !== 'number') return s;
        if (s.retryTargetStage === index) return { ...s, retryTargetStage: undefined };
        if (s.retryTargetStage > index) return { ...s, retryTargetStage: s.retryTargetStage - 1 };
        return s;
      });
    });
    setExpandedStep(null);
  };

  const updateStep = (index: number, update: Partial<PipelineStep>) => {
    setSteps(prev => prev.map((s, i) => i === index ? { ...s, ...update } : s));
  };

  const removeStep = (index: number) => deleteStep(index);

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    if (from < 0 || from >= steps.length || to < 0 || to >= steps.length) return;
    setSteps(prev => reorderStages(prev, from, to));
    // Follow the moved/displaced expanded step to its new position.
    setExpandedStep(prev => {
      if (prev === null) return prev;
      if (prev === from) return to;
      if (from < to && prev > from && prev <= to) return prev - 1;
      if (from > to && prev >= to && prev < from) return prev + 1;
      return prev;
    });
  };

  const moveStep = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= steps.length) return;
    reorder(index, newIndex);
  };

  const handleSubmit = () => {
    if (!name.trim()) {
      setErrors(['Template name is required.']);
      return;
    }
    const stageErrors = validatePipelineStages(steps);
    if (stageErrors.length > 0) {
      setErrors(stageErrors);
      setView('list'); // surface errors against the editable list
      return;
    }
    setErrors([]);
    onSave({ name, description: description || undefined, steps });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface-container rounded-xs shadow-xl border border-outline-variant/10 w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant/10">
          <h2 className="text-lg font-semibold text-white">
            {template ? 'Edit Template' : 'New Template'}
          </h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-white cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-on-surface-variant mb-1">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Code Review Pipeline"
              className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant/10 rounded-lg text-sm text-white"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-on-surface-variant mb-1">Description</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What does this pipeline do?"
              className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant/10 rounded-lg text-sm text-white"
            />
          </div>

          {/* Validation errors */}
          {errors.length > 0 && (
            <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error space-y-1">
              {errors.map((err, idx) => (
                <div key={idx}>{err}</div>
              ))}
            </div>
          )}

          {/* Steps */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-on-surface-variant">Steps</label>
              <div className="flex items-center gap-2">
                <div className="flex items-center bg-surface-container-high rounded-full p-0.5">
                  <button
                    type="button"
                    onClick={() => setView('list')}
                    title="List view"
                    className={`p-1 rounded-full cursor-pointer ${view === 'list' ? 'bg-primary/20 text-primary' : 'text-on-surface-variant hover:text-white'}`}
                  >
                    <List className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setView('graph')}
                    title="Graph view"
                    className={`p-1 rounded-full cursor-pointer ${view === 'graph' ? 'bg-primary/20 text-primary' : 'text-on-surface-variant hover:text-white'}`}
                  >
                    <Network className="w-3.5 h-3.5" />
                  </button>
                </div>
                <button
                  onClick={addStep}
                  className="text-xs text-primary hover:text-primary-container flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  Add Step
                </button>
              </div>
            </div>

            {view === 'graph' ? (
              <div className="rounded-lg border border-outline-variant/10 bg-surface-container-high p-3">
                <PipelineGraph
                  steps={steps}
                  selectedIndex={expandedStep ?? undefined}
                  onSelectStage={(i) => {
                    setExpandedStep(i);
                    setView('list');
                  }}
                  editable
                  onDeleteStage={deleteStep}
                  onInsertAfter={insertAfter}
                  onReorder={reorder}
                />
                <p className="mt-2 text-[11px] text-on-surface-variant">
                  Click a stage to edit. Drag the handle to reorder. Use + to insert, × to delete.
                </p>
              </div>
            ) : steps.length === 0 ? (
              <div className="text-center py-8 border-2 border-dashed border-outline-variant/10 rounded-lg">
                <p className="text-sm text-on-surface-variant mb-2">No steps yet</p>
                <button
                  onClick={addStep}
                  className="text-sm text-primary hover:text-primary-container"
                >
                  Add your first step
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {steps.map((step, i) => (
                  <div
                    key={i}
                    className="border border-outline-variant/10 rounded-lg"
                  >
                    {/* Step header */}
                    <div
                      className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-container-high"
                      onClick={() => setExpandedStep(expandedStep === i ? null : i)}
                    >
                      <GripVertical className="w-4 h-4 text-on-surface-variant shrink-0" />
                      <span className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium shrink-0">
                        {i + 1}
                      </span>
                      <span className="text-sm font-medium text-white flex-1 truncate">
                        {step.name || 'Untitled step'}
                      </span>
                      <span className="text-xs text-on-surface-variant font-mono">{step.topic}</span>
                      {step.requiresApproval && (
                        <Shield className="w-3.5 h-3.5 text-orange-500 shrink-0" />
                      )}
                      <div className="flex items-center gap-0.5">
                        <button
                          onClick={e => { e.stopPropagation(); moveStep(i, 'up'); }}
                          disabled={i === 0}
                          className="p-0.5 text-on-surface-variant hover:text-white disabled:opacity-30"
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); moveStep(i, 'down'); }}
                          disabled={i === steps.length - 1}
                          className="p-0.5 text-on-surface-variant hover:text-white disabled:opacity-30"
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); removeStep(i); }}
                          className="p-0.5 text-on-surface-variant hover:text-error cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Expanded step editor */}
                    {expandedStep === i && (
                      <div className="px-3 pb-3 space-y-3 border-t border-outline-variant/10 pt-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs text-on-surface-variant mb-1">Step Name</label>
                            <input
                              value={step.name}
                              onChange={e => updateStep(i, { name: e.target.value })}
                              placeholder="e.g. Analyze Code"
                              className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-white"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-on-surface-variant mb-1">Topic</label>
                            <select
                              value={step.topic}
                              onChange={e => updateStep(i, { topic: e.target.value })}
                              className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-white"
                            >
                              {AVAILABLE_TOPICS.map(t => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs text-on-surface-variant mb-1">Description</label>
                          <input
                            value={step.description ?? ''}
                            onChange={e => updateStep(i, { description: e.target.value })}
                            placeholder="What this step does..."
                            className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-white"
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-on-surface-variant mb-1">Prompt Template</label>
                          <textarea
                            value={step.promptTemplate ?? ''}
                            onChange={e => updateStep(i, { promptTemplate: e.target.value })}
                            placeholder="Use {{description}} and {{previousOutput}} as variables..."
                            rows={3}
                            className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-white font-mono resize-none"
                          />
                        </div>

                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={step.requiresApproval ?? false}
                            onChange={e => updateStep(i, { requiresApproval: e.target.checked })}
                            className="rounded border-outline-variant text-primary focus:ring-primary"
                          />
                          <span className="text-sm text-on-surface-variant">Require approval before running</span>
                        </label>

                        {/* QA Validation / Retry config */}
                        <div className="border-t border-outline-variant/10 pt-3 mt-1">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={step.stageType === 'qa_validation'}
                              onChange={e => updateStep(i, {
                                stageType: e.target.checked ? 'qa_validation' : 'standard',
                                ...(e.target.checked ? { maxRetries: 3, retryTargetStage: Math.max(0, i - 1) } : { maxRetries: undefined, retryTargetStage: undefined }),
                              })}
                              className="rounded border-outline-variant text-primary focus:ring-primary"
                            />
                            <span className="text-sm text-on-surface-variant">QA validation stage (retry on failure)</span>
                          </label>

                          {step.stageType === 'qa_validation' && (
                            <div className="mt-2 ml-6 space-y-2">
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-xs text-on-surface-variant mb-1">Max Retries</label>
                                  <input
                                    type="number"
                                    min={1}
                                    max={10}
                                    value={step.maxRetries ?? 3}
                                    onChange={e => updateStep(i, { maxRetries: parseInt(e.target.value) || 3 })}
                                    className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-white"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs text-on-surface-variant mb-1">Retry Stage</label>
                                  <select
                                    value={step.retryTargetStage ?? 0}
                                    onChange={e => updateStep(i, { retryTargetStage: parseInt(e.target.value) })}
                                    className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-white"
                                  >
                                    {steps.map((s, si) => si !== i ? (
                                      <option key={si} value={si}>
                                        Step {si + 1}: {s.name || 'Untitled'}
                                      </option>
                                    ) : null)}
                                  </select>
                                </div>
                              </div>
                              <p className="text-[11px] text-on-surface-variant">
                                If QA fails, the retry stage will re-run with feedback, then QA re-validates. After max retries, escalates for user approval.
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-outline-variant/10">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-on-surface-variant hover:text-white hover:bg-surface-container-high rounded-full"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim()}
            className="px-4 py-2 text-sm bg-linear-to-r from-primary to-primary-container text-on-primary cursor-pointer rounded-full hover:opacity-90 disabled:opacity-50 font-medium"
          >
            {template ? 'Save Changes' : 'Create Template'}
          </button>
        </div>
      </div>
    </div>
  );
}
