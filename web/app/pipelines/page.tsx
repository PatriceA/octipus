'use client';

import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  GitBranch,
  HelpCircle,
  ListChecks,
  Repeat,
  GripVertical,
  List,
  Network,
  Pencil,
  Plus,
  RotateCcw,
  Shield,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { PipelineGraph, validatePipelineStages } from '@/components/pipeline-graph';
import { PageHeader } from '@/components/ui/page-header';
import { Portal } from '@/components/ui/portal';
import { describePlanLoops, type PlanLoopInfo, reorderStages } from '../../../src/core/agent/pipeline-validation';
import { api } from '@/lib/api';
import { WORKER_ROLES } from '@/lib/types/models';

interface PipelineStep {
  name: string;
  description?: string;
  topic: string;
  skillIds?: string[];
  autoSkills?: boolean;
  loopOverPlan?: boolean;
  producesPlan?: boolean;
  maxPlanItems?: number;
  requiresApproval?: boolean;
  promptTemplate?: string;
  stageType?: 'standard' | 'qa_validation' | 'human_input';
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
  const queryClient = useQueryClient();
  const [showEditor, setShowEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<PipelineTemplate | null>(null);

  const { data, isLoading: loading } = useQuery({
    queryKey: ['pipeline-templates'],
    queryFn: () => api.get<{ templates: PipelineTemplate[] }>('/pipelines/templates'),
  });
  const templates = data?.templates ?? [];

  // Patch the cached list in place so the UI updates without a round-trip,
  // mirroring the previous local-state mutations.
  const setTemplates = (next: PipelineTemplate[] | ((prev: PipelineTemplate[]) => PipelineTemplate[])) => {
    queryClient.setQueryData<{ templates: PipelineTemplate[] }>(['pipeline-templates'], (prev) => {
      const list = prev?.templates ?? [];
      return { templates: typeof next === 'function' ? next(list) : next };
    });
  };

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

  const handleSave = async (formData: { name: string; description?: string; steps: PipelineStep[] }) => {
    try {
      if (editingTemplate) {
        const updated = await api.put<PipelineTemplate>(`/pipelines/templates/${editingTemplate.id}`, formData);
        setTemplates(prev => prev.map(t => t.id === editingTemplate.id ? updated : t));
      } else {
        const created = await api.post<PipelineTemplate>('/pipelines/templates', formData);
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
      <PageHeader
        title="pipelines"
        description="multi-stage agent workflows — chain specialists in sequence with approval gates and automatic qa retries"
        actions={
          <button
            onClick={handleCreate}
            className="flex items-center gap-2 px-4 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary cursor-pointer rounded-full hover:opacity-90 text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            New Template
          </button>
        }
      />

      {/* Template list */}
      {templates.length === 0 ? (
        <div className="text-center py-16 bg-surface-container rounded-xs border border-outline-variant/10 font-mono">
          <span aria-hidden className="block text-lg text-outline mb-3">[--]</span>
          <h3 className="text-sm text-on-surface mb-2 lowercase">no pipeline templates</h3>
          <p className="text-[12px] text-on-surface-variant mb-4">
            create a template to chain specialist agents in sequence — each step gets its own role, prompt, and approval gate
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
        <div className="grid gap-4 stagger">
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
  const cardLoops = describePlanLoops(template.steps);

  return (
    <div className="bg-surface-container rounded-xs border border-outline-variant/10 p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary" />
            <h3 className="font-medium text-on-surface">{template.name}</h3>
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
                className={`p-1 rounded-full cursor-pointer ${view === 'list' ? 'bg-primary/20 text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
              >
                <List className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setView('graph')}
                title="Graph view"
                className={`p-1 rounded-full cursor-pointer ${view === 'graph' ? 'bg-primary/20 text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
              >
                <Network className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <button
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${template.name}`}
            onClick={() => setExpanded(!expanded)}
            className="p-1.5 text-on-surface-variant hover:text-on-surface rounded cursor-pointer"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          <button
            aria-label={`Edit ${template.name}`}
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
                <Fragment key={i}>
                {cardLoops.find((l) => l.start === i) && <LoopBanner loop={cardLoops.find((l) => l.start === i) as PlanLoopInfo} steps={template.steps} />}
                <div
                  className={`flex items-center gap-3 text-sm pl-2 ${loopOf(cardLoops, i) ? 'ml-3 border-l-2 border-primary/30' : ''}`}
                >
                  <span className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium">
                    {i + 1}
                  </span>
                  <span className="font-medium text-on-surface">{step.name}</span>
                  <span className="text-xs bg-surface-container-high text-on-surface-variant px-1.5 py-0.5 rounded font-mono">
                    {step.topic}
                  </span>
                  {step.producesPlan && (
                    <span title="Writes the plan" className="inline-flex items-center gap-1 text-xs text-primary">
                      <ListChecks className="w-3.5 h-3.5" /> writes plan
                    </span>
                  )}
                  {!!step.skillIds?.length && (
                    <span title={`Skills loaded in full: ${step.skillIds.join(', ')}`} className="inline-flex items-center gap-1 text-xs text-on-surface-variant">
                      <BookOpen className="w-3.5 h-3.5" /> {step.skillIds.length}
                    </span>
                  )}
                  {step.autoSkills && (
                    <span title="The decision model may add skills for each task">
                      <Sparkles className="w-3.5 h-3.5 text-primary" />
                    </span>
                  )}
                  {step.requiresApproval && (
                    <span title="Requires approval">
                      <Shield className="w-3.5 h-3.5 text-warning" />
                    </span>
                  )}
                  {(step as any).stageType === 'qa_validation' && (
                    <span title={`QA validation (retries step ${((step as any).retryTargetStage ?? 0) + 1}, max ${(step as any).maxRetries ?? 3})`}>
                      <RotateCcw className="w-3.5 h-3.5 text-primary" />
                    </span>
                  )}
                </div>
                </Fragment>
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

  // Live, because roles are now user-definable (Topics page): a role someone
  // created is exactly the one they want in a pipeline, and a hardcoded list
  // cannot show it. WORKER_ROLES stays the fallback for a failed fetch, so the
  // step editor never renders an empty dropdown.
  const { data: rolesData } = useQuery({
    queryKey: ['roles-config'],
    queryFn: () => api.get<{ roles: Array<{ role: string; lane: string }> }>('/roles'),
  });
  const { data: skillsData } = useQuery({
    queryKey: ['skills'],
    queryFn: () => api.get<{ skills: SkillOption[] }>('/skills'),
  });
  const skillOptions = skillsData?.skills ?? [];
  const loops = describePlanLoops(steps);
  const roleOptions = rolesData?.roles?.length
    ? rolesData.roles.map((r) => ({ value: r.role, label: r.role }))
    : WORKER_ROLES;

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
    <Portal>
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface-container rounded-xs shadow-xl border border-outline-variant/10 w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant/10">
          <h2 className="text-lg font-semibold text-on-surface lowercase term-prompt">
            {template ? 'Edit Template' : 'New Template'}
          </h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface cursor-pointer">
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
              className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant/10 rounded-lg text-sm text-on-surface"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-on-surface-variant mb-1">Description</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What does this pipeline do?"
              className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant/10 rounded-lg text-sm text-on-surface"
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
              <label className="block section-label">Steps</label>
              <div className="flex items-center gap-2">
                <div className="flex items-center bg-surface-container-high rounded-full p-0.5">
                  <button
                    type="button"
                    onClick={() => setView('list')}
                    title="List view"
                    className={`p-1 rounded-full cursor-pointer ${view === 'list' ? 'bg-primary/20 text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                  >
                    <List className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setView('graph')}
                    title="Graph view"
                    className={`p-1 rounded-full cursor-pointer ${view === 'graph' ? 'bg-primary/20 text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
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

            <div className="mb-2"><LoopsHelp /></div>

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
              <div className="text-center py-8 border-2 border-dashed border-outline-variant/10 rounded-lg font-mono">
                <span aria-hidden className="block text-lg text-outline mb-1">[ ]</span>
                <p className="text-[12px] text-on-surface-variant mb-2">no steps yet</p>
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
                  <Fragment key={i}>
                  {loops.find((l) => l.start === i) && <LoopBanner loop={loops.find((l) => l.start === i) as PlanLoopInfo} steps={steps} />}
                  <div
                    className={`border border-outline-variant/10 rounded-lg ${loopOf(loops, i) ? 'ml-3 border-l-2 border-l-primary/40' : ''}`}
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
                      <span className="text-sm font-medium text-on-surface flex-1 truncate">
                        {step.name || 'Untitled step'}
                      </span>
                      <span className="text-xs text-on-surface-variant font-mono">{step.topic}</span>
                      {step.producesPlan && <span title="Writes the plan"><ListChecks className="w-3.5 h-3.5 text-primary shrink-0" /></span>}
                      {step.loopOverPlan && <span title="Repeats for each plan item"><Repeat className="w-3.5 h-3.5 text-primary shrink-0" /></span>}
                      {step.stageType === 'qa_validation' && <span title="QA retry"><RotateCcw className="w-3.5 h-3.5 text-primary shrink-0" /></span>}
                      {!!step.skillIds?.length && <span title="Skills loaded in full"><BookOpen className="w-3.5 h-3.5 text-on-surface-variant shrink-0" /></span>}
                      {step.requiresApproval && (
                        <Shield className="w-3.5 h-3.5 text-warning shrink-0" />
                      )}
                      <div className="flex items-center gap-0.5">
                        <button
                          onClick={e => { e.stopPropagation(); moveStep(i, 'up'); }}
                          disabled={i === 0}
                          className="p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-30"
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); moveStep(i, 'down'); }}
                          disabled={i === steps.length - 1}
                          className="p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-30"
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
                              className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-on-surface"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-on-surface-variant mb-1">Role</label>
                            <select
                              aria-label="Role"
                              value={step.topic}
                              onChange={e => updateStep(i, { topic: e.target.value })}
                              className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-on-surface"
                            >
                              {roleOptions.map(t => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <p className="text-xs text-on-surface-variant">
                          The role defines the work and tools. Models come from its topic assignment
                          {rolesData?.roles?.find(role => role.role === step.topic)?.lane ? ` (${rolesData.roles.find(role => role.role === step.topic)?.lane})` : ''}.
                        </p>

                        <div>
                          <label className="block text-xs text-on-surface-variant mb-1">Description</label>
                          <input
                            value={step.description ?? ''}
                            onChange={e => updateStep(i, { description: e.target.value })}
                            placeholder="What this step does..."
                            className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-on-surface"
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-on-surface-variant mb-1">Prompt Template</label>
                          <textarea
                            value={step.promptTemplate ?? ''}
                            onChange={e => updateStep(i, { promptTemplate: e.target.value })}
                            placeholder="Use {{description}} and {{previousOutput}} as variables..."
                            rows={3}
                            className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-on-surface font-mono resize-none"
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

                        {/* Ask a person instead of an agent. Mutually exclusive
                            with QA: a human step runs no worker, so it has no
                            verdict to route on. */}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={step.stageType === 'human_input'}
                            onChange={e => updateStep(i, {
                              stageType: e.target.checked ? 'human_input' : 'standard',
                              ...(e.target.checked ? { maxRetries: undefined, retryTargetStage: undefined } : {}),
                            })}
                            className="rounded border-outline-variant text-primary focus:ring-primary"
                          />
                          <span className="text-sm text-on-surface-variant">
                            Ask me (human step — the prompt is the question, my answer is the output)
                          </span>
                        </label>

                        {/* QA Validation / Retry config */}
                        <div className="border-t border-outline-variant/10 pt-3 mt-1">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={step.stageType === 'qa_validation'}
                              disabled={step.stageType === 'human_input'}
                              onChange={e => updateStep(i, {
                                stageType: e.target.checked ? 'qa_validation' : 'standard',
                                ...(e.target.checked ? { maxRetries: 3, retryTargetStage: defaultRetryTarget(loops, i) } : { maxRetries: undefined, retryTargetStage: undefined }),
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
                                    className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-on-surface"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs text-on-surface-variant mb-1">Retry Stage</label>
                                  <select
                                    value={step.retryTargetStage ?? 0}
                                    onChange={e => updateStep(i, { retryTargetStage: parseInt(e.target.value) })}
                                    className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-on-surface"
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
                                {loopOf(loops, i) && ' Inside the plan loop, the retry stage must be in the same loop and every item gets its own retries.'}
                              </p>
                            </div>
                          )}
                        </div>

                        <PlanLoopSettings index={i} steps={steps} loops={loops} updateStep={updateStep} setSteps={setSteps} />

                        {step.stageType !== 'human_input' && (
                          <StageSkills step={step} skills={skillOptions} onChange={(update) => updateStep(i, update)} />
                        )}
                      </div>
                    )}
                  </div>
                  </Fragment>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-outline-variant/10">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high rounded-full"
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
    </Portal>
  );
}

/** One sentence that says what a plan loop does, for the list views and the editor. */
function loopSummary(loop: PlanLoopInfo, steps: PipelineStep[]): string {
  const range = loop.start === loop.end ? `Step ${loop.start + 1} repeats` : `Steps ${loop.start + 1}–${loop.end + 1} repeat`;
  const source = loop.plannerIndex !== null
    ? `the plan written by step ${loop.plannerIndex + 1} (${steps[loop.plannerIndex]?.name || 'Untitled'})`
    : 'the plan (no earlier step writes one — it must come from a linked work plan)';
  const cap = loop.maxItems ? `, at most ${loop.maxItems} item${loop.maxItems === 1 ? '' : 's'} per run` : '';
  const approval = loop.approvesPlan ? '; you approve the plan once before it starts' : '';
  return `${range} once for each item of ${source}${cap}${approval}.`;
}

/** Header row drawn above the first step of a plan loop. */
function LoopBanner({ loop, steps }: { loop: PlanLoopInfo; steps: PipelineStep[] }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs text-primary">
      <Repeat className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <span>
        <span className="font-medium">Plan loop — </span>
        {loopSummary(loop, steps)}
      </span>
    </div>
  );
}

/** A new QA step retries the step before it — inside a plan loop, the loop's first step (the one that owns the work). */
function defaultRetryTarget(loops: PlanLoopInfo[], index: number): number {
  const loop = loopOf(loops, index);
  return loop && index > loop.start ? loop.start : Math.max(0, index - 1);
}

/** The step's plan loop, when it is part of one. */
function loopOf(loops: PlanLoopInfo[], index: number): PlanLoopInfo | undefined {
  return loops.find((l) => index >= l.start && index <= l.end);
}

/** What the two loops a pipeline can run are, in plain words. Collapsed by default. */
function LoopsHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-outline-variant/10 bg-surface-container-high text-xs text-on-surface-variant">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:text-on-surface"
      >
        <HelpCircle className="w-3.5 h-3.5" />
        <span className="flex-1 text-left">How pipelines loop</span>
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          <p>
            <span className="inline-flex items-center gap-1 font-medium text-on-surface"><RotateCcw className="w-3 h-3" /> QA retry</span>{' '}
            — a QA step that fails sends its findings back to its retry step, which runs again; then QA checks again.
            After its max retries you decide whether to continue or stop.
          </p>
          <p>
            <span className="inline-flex items-center gap-1 font-medium text-on-surface"><Repeat className="w-3 h-3" /> Plan loop</span>{' '}
            — one step <em>writes the plan</em>: it breaks the task into items. Consecutive steps marked
            <em> repeat for each plan item</em> then run once per item, in order — e.g. implement → review → QA for
            item 1, then again for item 2. Each pass is told which item it is on and works only on that item.
          </p>
          <ul className="list-disc ml-4 space-y-1">
            <li>Steps inside the loop can add items they discover; the loop picks them up in the same run. You can also edit, reorder or skip items on the pipeline page while it runs.</li>
            <li>A QA step inside the loop retries per item: its retry step must be inside the same loop, and every item gets a fresh retry budget.</li>
            <li>If the loop’s first step requires approval, you approve the whole plan once before the first item, not every item.</li>
            <li>The item limit is a safety cap: items beyond it are marked skipped with the reason, never silently dropped.</li>
          </ul>
        </div>
      )}
    </div>
  );
}

/** The loop settings of one step. Loop-wide settings live on the loop's first step. */
function PlanLoopSettings({
  index,
  steps,
  loops,
  updateStep,
  setSteps,
}: {
  index: number;
  steps: PipelineStep[];
  loops: PlanLoopInfo[];
  updateStep: (index: number, update: Partial<PipelineStep>) => void;
  setSteps: React.Dispatch<React.SetStateAction<PipelineStep[]>>;
}) {
  const step = steps[index];
  const loop = loopOf(loops, index);
  const isHuman = step.stageType === 'human_input';

  const toggleLoop = (on: boolean) => {
    setSteps((prev) => prev.map((s, i) => {
      if (i === index) return { ...s, loopOverPlan: on || undefined, maxPlanItems: on ? s.maxPlanItems : undefined };
      // The loop's cap travels to the step that becomes the loop's first.
      if (!on && i === index + 1 && s.loopOverPlan && prev[index].maxPlanItems && loop?.start === index) {
        return { ...s, maxPlanItems: prev[index].maxPlanItems };
      }
      return s;
    }));
  };

  /** Set the loop's cap on its first step, clearing it on the rest of the loop. */
  const setCap = (value: number | undefined) => {
    if (!loop) return;
    setSteps((prev) => prev.map((s, i) => {
      if (i < loop.start || i > loop.end) return s;
      return { ...s, maxPlanItems: i === loop.start ? value : undefined };
    }));
  };

  return (
    <div className="border-t border-outline-variant/10 pt-3 mt-1 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-on-surface">
        <Repeat className="w-3.5 h-3.5 text-primary" /> Plan loop
      </div>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!step.producesPlan}
          disabled={isHuman || !!step.loopOverPlan}
          onChange={(e) => updateStep(index, { producesPlan: e.target.checked || undefined })}
          className="mt-0.5 rounded border-outline-variant text-primary focus:ring-primary"
        />
        <span className="text-sm text-on-surface-variant">
          Writes the plan
          <span className="block text-[11px]">This step breaks the task into plan items. It must leave at least one item, or it fails.</span>
        </span>
      </label>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!step.loopOverPlan}
          disabled={!!step.producesPlan}
          onChange={(e) => toggleLoop(e.target.checked)}
          className="mt-0.5 rounded border-outline-variant text-primary focus:ring-primary"
        />
        <span className="text-sm text-on-surface-variant">
          Repeat for each plan item
          <span className="block text-[11px]">Consecutive steps with this checked form one loop that runs once per item.</span>
        </span>
      </label>
      {loop && (
        <div className="ml-6 space-y-2">
          <p className="text-[11px] text-primary">{loopSummary(loop, steps)}</p>
          {loop.start === index ? (
            <div className="max-w-[12rem]">
              <label className="block text-xs text-on-surface-variant mb-1">Max items per run</label>
              <input
                type="number"
                min={1}
                placeholder="No limit"
                aria-label="Max items per run"
                value={loop.maxItems ?? ''}
                onChange={(e) => setCap(e.target.value === '' ? undefined : Math.max(1, parseInt(e.target.value) || 1))}
                className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-on-surface"
              />
            </div>
          ) : (
            <p className="text-[11px] text-on-surface-variant">The loop’s item limit is set on step {loop.start + 1}.</p>
          )}
          {loop.start === index && (
            <p className="text-[11px] text-on-surface-variant">
              “Require approval” on this step asks you to approve the whole plan once, before the first item.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface SkillOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
}

/** Skills loaded in full into this step's agent, plus the decision-model opt-in. */
function StageSkills({
  step,
  skills,
  onChange,
}: {
  step: PipelineStep;
  skills: SkillOption[];
  onChange: (update: Partial<PipelineStep>) => void;
}) {
  const [query, setQuery] = useState('');
  const selected = step.skillIds ?? [];
  const byId = new Map(skills.map((s) => [s.id, s]));
  const q = query.trim().toLowerCase();
  const matches = q
    ? skills
      .filter((s) => !selected.includes(s.id))
      .filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q))
      .slice(0, 8)
    : [];
  const setIds = (ids: string[]) => onChange({ skillIds: ids.length ? ids : undefined });

  return (
    <div className="border-t border-outline-variant/10 pt-3 mt-1 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-on-surface">
        <BookOpen className="w-3.5 h-3.5 text-primary" /> Skills
      </div>
      <p className="text-[11px] text-on-surface-variant">
        Selected skills are loaded in full into this step’s agent prompt — API and CLI agents alike — instead of
        only being listed for the agent to fetch itself.
      </p>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs">
              {byId.get(id)?.name ?? id}
              {!byId.has(id) && skills.length > 0 && <span className="text-error" title="This skill is not available — the step will fail until it is removed">(missing)</span>}
              <button
                type="button"
                aria-label={`Remove skill ${byId.get(id)?.name ?? id}`}
                onClick={() => setIds(selected.filter((x) => x !== id))}
                className="hover:text-error cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills to add…"
          aria-label="Search skills to add"
          className="w-full px-2.5 py-1.5 bg-surface-container-high border border-outline-variant/10 rounded text-sm text-on-surface"
        />
        {matches.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded border border-outline-variant/20 bg-surface-container shadow-lg">
            {matches.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => { setIds([...selected, s.id]); setQuery(''); }}
                  className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-surface-container-high cursor-pointer"
                >
                  <span className="text-on-surface">{s.name}</span>
                  {s.description && <span className="block text-[11px] text-on-surface-variant truncate">{s.description}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!step.autoSkills}
          onChange={(e) => onChange({ autoSkills: e.target.checked || undefined })}
          className="mt-0.5 rounded border-outline-variant text-primary focus:ring-primary"
        />
        <span className="text-sm text-on-surface-variant">
          <span className="inline-flex items-center gap-1"><Sparkles className="w-3 h-3" /> Let the decision model add skills for each task</span>
          <span className="block text-[11px]">
            Before each run of this step, the model on the Decision topic checks the skills found for the task and
            loads the ones it is confident about. Needs a local decision model (the task includes workspace code);
            without one, nothing is added.
          </span>
        </span>
      </label>
    </div>
  );
}
