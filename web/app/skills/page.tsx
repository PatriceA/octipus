'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileText,
  Layers,
  Lightbulb,
  List,
  Loader2,
  Pencil,
  Plus,
  Search,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Skill {
  id: string;
  name: string;
  category: string;
  description: string;
  content?: string;
  principles: string[];
  bestPractices: string[];
  antiPatterns: string[];
  frameworks: string[];
  isSystem: boolean;
}

// Categories match agent role / model topic names — see src/core/orchestrator/roles.ts
const CATEGORIES = [
  'coding',
  'architecture',
  'review',
  'qa',
  'research',
  'design',
  'devops',
  'security',
  'data',
  'ai',
  'finance',
  'automation',
  'pm',
  'writing',
  'communication',
  'general',
];

const CATEGORY_COLORS: Record<string, string> = {
  coding: 'bg-blue-900/30 text-primary',
  architecture: 'bg-sky-900/30 text-sky-300',
  review: 'bg-cyan-900/30 text-primary',
  qa: 'bg-teal-900/30 text-tertiary',
  research: 'bg-violet-900/30 text-primary',
  design: 'bg-purple-900/30 text-primary',
  devops: 'bg-orange-900/30 text-warning',
  security: 'bg-red-900/30 text-error',
  data: 'bg-green-900/30 text-tertiary',
  ai: 'bg-indigo-900/30 text-primary',
  finance: 'bg-emerald-900/30 text-tertiary',
  automation: 'bg-amber-900/30 text-warning',
  pm: 'bg-yellow-900/30 text-warning',
  writing: 'bg-rose-900/30 text-error',
  communication: 'bg-pink-900/30 text-error',
  general: 'bg-slate-900/30 text-slate-300',
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || 'bg-surface-container-high text-on-surface-variant';
}

// --- Array field input component ---
function ArrayFieldInput({
  label,
  items,
  onAdd,
  onRemove,
}: {
  label: string;
  items: string[];
  onAdd: (item: string) => void;
  onRemove: (index: number) => void;
}) {
  const [value, setValue] = useState('');

  const handleAdd = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onAdd(trimmed);
      setValue('');
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-on-surface/80 mb-1">{label}</label>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder={`Add ${label.toLowerCase()}...`}
          className="flex-1 px-3 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
        />
        <button
          type="button"
          onClick={handleAdd}
          className="px-3 py-2 bg-surface-container-high text-on-surface/80 rounded-lg text-sm hover:bg-surface-container-high cursor-pointer"
        >
          Add
        </button>
      </div>
      {items.length > 0 && (
        <div className="space-y-1">
          {items.map((item, i) => (
            <div key={i} className="flex items-center gap-2 text-sm text-on-surface/80 bg-surface-container-low rounded-lg px-3 py-1.5">
              <span className="flex-1">{item}</span>
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="text-on-surface-variant hover:text-error cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Mode toggle for Markdown vs Structured ---
function ModeToggle({ mode, onChange }: { mode: 'markdown' | 'structured'; onChange: (m: 'markdown' | 'structured') => void }) {
  return (
    <div className="flex rounded-lg bg-surface-container-high p-0.5">
      <button
        type="button"
        onClick={() => onChange('markdown')}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors',
          mode === 'markdown' ? 'bg-surface-container-high text-on-surface shadow-xs' : 'text-on-surface-variant'
        )}
      >
        <FileText className="w-3.5 h-3.5" /> Markdown
      </button>
      <button
        type="button"
        onClick={() => onChange('structured')}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors',
          mode === 'structured' ? 'bg-surface-container-high text-on-surface shadow-xs' : 'text-on-surface-variant'
        )}
      >
        <List className="w-3.5 h-3.5" /> Structured
      </button>
    </div>
  );
}

// --- Create Skill Dialog ---
function CreateSkillDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<'markdown' | 'structured'>('markdown');

  const [name, setName] = useState('');
  const [category, setCategory] = useState('general');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [principles, setPrinciples] = useState<string[]>([]);
  const [bestPractices, setBestPractices] = useState<string[]>([]);
  const [antiPatterns, setAntiPatterns] = useState<string[]>([]);
  const [frameworks, setFrameworks] = useState<string[]>([]);
  // Topics drive runtime injection — independent from `category`, which is
  // just the UI grouping. Allow users to attach topics on create so they
  // don't have to open the edit dialog as a second step.
  const [topics, setTopics] = useState<string[]>([]);

  const toggleTopic = (t: string) => {
    setTopics((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (mode === 'markdown' && !content.trim()) {
      setError('Markdown content is required');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const created = await api.post<{ id: string }>('/skills', {
        name: name.trim(),
        category,
        description: description.trim() || (mode === 'markdown' ? content.trim().split('\n')[0].replace(/^#\s*/, '').slice(0, 200) : ''),
        content: mode === 'markdown' ? content : '',
        principles: mode === 'structured' ? principles : [],
        bestPractices: mode === 'structured' ? bestPractices : [],
        antiPatterns: mode === 'structured' ? antiPatterns : [],
        frameworks: mode === 'structured' ? frameworks : [],
      });
      // Attach selected topics. Failures here don't roll back skill creation —
      // the user can still adjust topics from the edit dialog.
      if (created?.id && topics.length > 0) {
        await Promise.all(
          topics.map((topic) =>
            api.post('/skills/topics', { skillId: created.id, topic, isActive: true }).catch(() => null),
          ),
        );
      }
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create skill');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-container rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-outline-variant/10">
          <h2 className="text-lg font-semibold text-on-surface">Create Skill</h2>
          <div className="flex items-center gap-3">
            <ModeToggle mode={mode} onChange={setMode} />
            <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="text-sm text-error bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-on-surface/80 mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Skill name"
                className="w-full px-3 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface/80 mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              <p className="text-xs text-on-surface-variant mt-1">UI grouping — does not affect agent discovery.</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-on-surface/80 mb-1">
              Topics
              <span className="ml-2 text-xs font-normal text-on-surface-variant">
                Controls when this skill is injected into an agent prompt
              </span>
            </label>
            <div className="grid grid-cols-3 gap-1.5 p-2 bg-surface-container border border-outline-variant/10 rounded-lg max-h-40 overflow-y-auto">
              {CATEGORIES.map((t) => {
                const selected = topics.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTopic(t)}
                    className={cn(
                      'px-2 py-1 text-xs rounded-md text-left cursor-pointer transition-colors',
                      selected
                        ? 'bg-primary text-on-surface'
                        : 'bg-surface-container-high text-on-surface/70 hover:bg-surface-container-high',
                    )}
                  >
                    {selected ? '✓ ' : ''}{t}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-on-surface/80 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={mode === 'markdown' ? 'Short description (auto-generated from content if empty)' : 'Skill description'}
              className="w-full px-3 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
            />
          </div>

          {mode === 'markdown' ? (
            <div>
              <label className="block text-sm font-medium text-on-surface/80 mb-1">
                Markdown Content
                <span className="ml-2 text-xs font-normal text-on-surface-variant">Paste a Claude Code skill (.md) or write your own</span>
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={"# My Skill\n\nInstructions for the AI agent...\n\n## Guidelines\n- Do this\n- Don't do that\n\n## Examples\n..."}
                rows={16}
                className="w-full px-3 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface resize-y font-mono"
              />
            </div>
          ) : (
            <>
              <ArrayFieldInput
                label="Principles"
                items={principles}
                onAdd={(item) => setPrinciples([...principles, item])}
                onRemove={(i) => setPrinciples(principles.filter((_, idx) => idx !== i))}
              />
              <ArrayFieldInput
                label="Best Practices"
                items={bestPractices}
                onAdd={(item) => setBestPractices([...bestPractices, item])}
                onRemove={(i) => setBestPractices(bestPractices.filter((_, idx) => idx !== i))}
              />
              <ArrayFieldInput
                label="Anti-Patterns"
                items={antiPatterns}
                onAdd={(item) => setAntiPatterns([...antiPatterns, item])}
                onRemove={(i) => setAntiPatterns(antiPatterns.filter((_, idx) => idx !== i))}
              />
              <ArrayFieldInput
                label="Frameworks"
                items={frameworks}
                onAdd={(item) => setFrameworks([...frameworks, item])}
                onRemove={(i) => setFrameworks(frameworks.filter((_, idx) => idx !== i))}
              />
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-on-surface/80 bg-surface-container-high rounded-lg hover:bg-surface-container-high cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer"
            >
              {submitting ? 'Creating...' : 'Create Skill'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Edit Skill Dialog ---
// --- Topic assignments panel ---
interface TopicAssignment {
  id: string;
  skillId: string;
  topic: string;
  isActive: boolean;
}

function TopicAssignmentsPanel({ skillId }: { skillId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<{ assignments: TopicAssignment[] }>({
    queryKey: ['skill-topic-assignments', skillId],
    queryFn: async () => api.get(`/skills/topics?skillId=${skillId}`),
  });
  const [pending, setPending] = useState<string | null>(null);

  const assignments = data?.assignments ?? [];
  const byTopic = new Map(assignments.map((a) => [a.topic, a]));

  const handleToggle = async (topic: string) => {
    setPending(topic);
    try {
      const existing = byTopic.get(topic);
      if (!existing) {
        await api.post('/skills/topics', { skillId, topic, isActive: true });
      } else if (existing.isActive) {
        // Active → inactive
        await api.patch(`/skills/topics/${existing.id}`, { isActive: false });
      } else {
        // Inactive → remove entirely
        await api.delete(`/skills/topics/${existing.id}`);
      }
      queryClient.invalidateQueries({ queryKey: ['skill-topic-assignments', skillId] });
    } finally {
      setPending(null);
    }
  };

  const handleBulk = async (isActive: boolean) => {
    setPending('__bulk__');
    try {
      // Ensure assignments exist for all topics first, then toggle
      if (isActive) {
        for (const topic of CATEGORIES) {
          if (!byTopic.has(topic)) {
            await api.post('/skills/topics', { skillId, topic, isActive: true });
          }
        }
      }
      await api.patch(`/skills/topics/bulk/${skillId}`, { isActive });
      queryClient.invalidateQueries({ queryKey: ['skill-topic-assignments', skillId] });
    } finally {
      setPending(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="block text-sm font-medium text-on-surface/80">
          Attached Topics
          <span className="ml-2 text-xs font-normal text-on-surface-variant">
            Active topics auto-inject this skill into worker prompts
          </span>
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleBulk(true)}
            disabled={pending !== null}
            className="text-xs px-2 py-1 bg-surface-container-high hover:bg-surface-container-high rounded cursor-pointer disabled:opacity-50"
          >
            Enable all
          </button>
          <button
            type="button"
            onClick={() => handleBulk(false)}
            disabled={pending !== null}
            className="text-xs px-2 py-1 bg-surface-container-high hover:bg-surface-container-high rounded cursor-pointer disabled:opacity-50"
          >
            Disable all
          </button>
        </div>
      </div>
      {isLoading ? (
        <div className="text-xs text-on-surface-variant">Loading assignments...</div>
      ) : (
        <div className="grid grid-cols-4 gap-1.5">
          {CATEGORIES.map((topic) => {
            const existing = byTopic.get(topic);
            const state = !existing ? 'off' : existing.isActive ? 'active' : 'attached';
            return (
              <button
                key={topic}
                type="button"
                onClick={() => handleToggle(topic)}
                disabled={pending !== null}
                title={
                  state === 'active' ? 'Active — click to deactivate'
                  : state === 'attached' ? 'Attached (inactive) — click to remove'
                  : 'Not attached — click to attach & activate'
                }
                className={cn(
                  'text-xs px-2 py-1.5 rounded border transition-colors cursor-pointer disabled:opacity-50',
                  state === 'active' && 'bg-primary/40 border-primary-700 text-on-surface',
                  state === 'attached' && 'bg-surface-container-high border-outline-variant/20 text-on-surface-variant',
                  state === 'off' && 'bg-transparent border-outline-variant/10 text-on-surface-variant/50 hover:border-outline-variant/30',
                )}
              >
                {topic}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EditSkillDialog({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const hasContent = !!(skill.content?.trim());
  const [mode, setMode] = useState<'markdown' | 'structured'>(hasContent ? 'markdown' : 'structured');

  const [name, setName] = useState(skill.name);
  const [category, setCategory] = useState(skill.category);
  const [description, setDescription] = useState(skill.description);
  const [content, setContent] = useState(skill.content || '');
  const [principles, setPrinciples] = useState<string[]>([...skill.principles]);
  const [bestPractices, setBestPractices] = useState<string[]>([...skill.bestPractices]);
  const [antiPatterns, setAntiPatterns] = useState<string[]>([...skill.antiPatterns]);
  const [frameworks, setFrameworks] = useState<string[]>([...skill.frameworks]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await api.patch(`/skills/${skill.id}`, {
        name: name.trim(),
        category,
        description: description.trim(),
        content: mode === 'markdown' ? content : '',
        principles: mode === 'structured' ? principles : [],
        bestPractices: mode === 'structured' ? bestPractices : [],
        antiPatterns: mode === 'structured' ? antiPatterns : [],
        frameworks: mode === 'structured' ? frameworks : [],
      });
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update skill');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-container rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-outline-variant/10">
          <h2 className="text-lg font-semibold text-on-surface">Edit Skill</h2>
          <div className="flex items-center gap-3">
            <ModeToggle mode={mode} onChange={setMode} />
            <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="text-sm text-error bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-on-surface/80 mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Skill name"
                className="w-full px-3 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface/80 mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-on-surface/80 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Skill description"
              className="w-full px-3 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
            />
          </div>

          {mode === 'markdown' ? (
            <div>
              <label className="block text-sm font-medium text-on-surface/80 mb-1">
                Markdown Content
                <span className="ml-2 text-xs font-normal text-on-surface-variant">Paste a Claude Code skill (.md) or write your own</span>
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={"# My Skill\n\nInstructions for the AI agent...\n\n## Guidelines\n- Do this\n- Don't do that"}
                rows={16}
                className="w-full px-3 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface resize-y font-mono"
              />
            </div>
          ) : (
            <>
              <ArrayFieldInput
                label="Principles"
                items={principles}
                onAdd={(item) => setPrinciples([...principles, item])}
                onRemove={(i) => setPrinciples(principles.filter((_, idx) => idx !== i))}
              />
              <ArrayFieldInput
                label="Best Practices"
                items={bestPractices}
                onAdd={(item) => setBestPractices([...bestPractices, item])}
                onRemove={(i) => setBestPractices(bestPractices.filter((_, idx) => idx !== i))}
              />
              <ArrayFieldInput
                label="Anti-Patterns"
                items={antiPatterns}
                onAdd={(item) => setAntiPatterns([...antiPatterns, item])}
                onRemove={(i) => setAntiPatterns(antiPatterns.filter((_, idx) => idx !== i))}
              />
              <ArrayFieldInput
                label="Frameworks"
                items={frameworks}
                onAdd={(item) => setFrameworks([...frameworks, item])}
                onRemove={(i) => setFrameworks(frameworks.filter((_, idx) => idx !== i))}
              />
            </>
          )}

          <div className="pt-2 border-t border-outline-variant/10">
            <TopicAssignmentsPanel skillId={skill.id} />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-on-surface/80 bg-surface-container-high rounded-lg hover:bg-surface-container-high cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer"
            >
              {submitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Delete Confirm Dialog ---
function DeleteSkillDialog({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setError('');
    setDeleting(true);
    try {
      await api.delete(`/skills/${skill.id}`);
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete skill');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-container rounded-xl shadow-xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-outline-variant/10">
          <h2 className="text-lg font-semibold text-on-surface">Delete Skill</h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="text-sm text-error bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <p className="text-sm text-on-surface/80">
            Are you sure you want to delete <strong>{skill.name}</strong>? This action cannot be undone.
          </p>

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-on-surface/80 bg-surface-container-high rounded-lg hover:bg-surface-container-high cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-4 py-2 text-sm bg-red-600 text-on-surface rounded-lg hover:bg-red-700 disabled:opacity-50 cursor-pointer"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Skill Card ---
function SkillCard({
  skill,
  onEdit,
  onDelete,
}: {
  skill: Skill;
  onEdit: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between text-left cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <div className="text-on-surface-variant">
            {expanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </div>
          <BookOpen className="w-5 h-5 text-primary" />
          <div>
            <h3 className="font-medium text-on-surface">{skill.name}</h3>
            <p className="text-xs text-on-surface-variant mt-0.5">{skill.description}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getCategoryColor(skill.category))}>
            {skill.category}
          </span>
          {skill.content?.trim() && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-violet-900/20 text-primary">
              md
            </span>
          )}
          {skill.isSystem && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-surface-container-high text-on-surface-variant">
              system
            </span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit(skill);
            }}
            className="p-1 text-on-surface-variant hover:text-primary cursor-pointer"
            title="Edit skill"
          >
            <Pencil className="w-4 h-4" />
          </button>
          {!skill.isSystem && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(skill);
                }}
                className="p-1 text-on-surface-variant hover:text-error cursor-pointer"
                title="Delete skill"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-outline-variant/10 p-4 space-y-4">
          {skill.content?.trim() ? (
            <div>
              <h4 className="text-sm font-medium text-on-surface/80 mb-2 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-primary" />
                Markdown Content
              </h4>
              <pre className="text-sm text-on-surface-variant bg-surface-container-low rounded-lg p-3 whitespace-pre-wrap font-mono overflow-x-auto max-h-96 overflow-y-auto">
                {skill.content}
              </pre>
            </div>
          ) : (
            <>
              {skill.principles.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-on-surface/80 mb-2 flex items-center gap-1.5">
                    <Lightbulb className="w-4 h-4 text-warning" />
                    Principles
                  </h4>
                  <ul className="space-y-1">
                    {skill.principles.map((p, i) => (
                      <li key={i} className="text-sm text-on-surface-variant pl-4 relative before:content-[''] before:absolute before:left-0 before:top-2 before:w-1.5 before:h-1.5 before:rounded-full before:bg-warning">
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {skill.bestPractices.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-on-surface/80 mb-2 flex items-center gap-1.5">
                    <ThumbsUp className="w-4 h-4 text-tertiary" />
                    Best Practices
                  </h4>
                  <ul className="space-y-1">
                    {skill.bestPractices.map((p, i) => (
                      <li key={i} className="text-sm text-on-surface-variant pl-4 relative before:content-[''] before:absolute before:left-0 before:top-2 before:w-1.5 before:h-1.5 before:rounded-full before:bg-tertiary">
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {skill.antiPatterns.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-on-surface/80 mb-2 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-error" />
                    Anti-Patterns
                  </h4>
                  <ul className="space-y-1">
                    {skill.antiPatterns.map((p, i) => (
                      <li key={i} className="text-sm text-on-surface-variant pl-4 relative before:content-[''] before:absolute before:left-0 before:top-2 before:w-1.5 before:h-1.5 before:rounded-full before:bg-error">
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {skill.frameworks.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-on-surface/80 mb-2 flex items-center gap-1.5">
                    <Layers className="w-4 h-4 text-primary" />
                    Frameworks
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {skill.frameworks.map((f, i) => (
                      <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-blue-900/20 text-primary">
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function SkillsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [deletingSkill, setDeletingSkill] = useState<Skill | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn: async () => {
      try {
        return await api.get<{ skills: Skill[] }>('/skills');
      } catch {
        return { skills: [] };
      }
    },
  });

  const skills = data?.skills || [];

  const categories = Array.from(new Set(skills.map((s) => s.category))).sort();

  const filtered = skills.filter((s) => {
    if (categoryFilter && s.category !== categoryFilter) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      s.content?.toLowerCase().includes(q) ||
      s.principles.some((p) => p.toLowerCase().includes(q)) ||
      s.frameworks.some((f) => f.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <BookOpen className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl text-on-surface">Skills</h1>
          <p className="text-on-surface-variant">
            Domain knowledge injected into agent prompts. Skills provide expertise in areas like software architecture, security practices, and API design.
          </p>
          <p className="text-sm text-on-surface-variant mt-1">
            {skills.length} skills across {categories.length} categories
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-on-primary rounded-xs hover:bg-primary-dim cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Create Skill
        </button>
      </div>

      {/* description already in header */}

      {/* Search + Category filter */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search skills, principles, frameworks..."
            className="w-full pl-10 pr-4 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button
            onClick={() => setCategoryFilter(null)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors',
              !categoryFilter
                ? 'bg-primary text-on-surface'
                : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-high'
            )}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors',
                categoryFilter === cat
                  ? 'bg-primary text-on-surface'
                  : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-high'
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Skills list */}
      {isLoading ? (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
          Loading...
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center">
          <BookOpen className="w-8 h-8 text-on-surface-variant mx-auto mb-2" />
          <p className="text-on-surface-variant">No skills found</p>
          <p className="text-sm text-on-surface-variant mt-1">Click &quot;Create Skill&quot; to add domain knowledge that agents can use during conversations.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onEdit={setEditingSkill}
              onDelete={setDeletingSkill}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      {showCreate && <CreateSkillDialog onClose={() => setShowCreate(false)} />}
      {editingSkill && <EditSkillDialog skill={editingSkill} onClose={() => setEditingSkill(null)} />}
      {deletingSkill && <DeleteSkillDialog skill={deletingSkill} onClose={() => setDeletingSkill(null)} />}
    </div>
  );
}
