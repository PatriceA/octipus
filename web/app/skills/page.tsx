'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Loader2,
  Search,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  ThumbsUp,
  AlertTriangle,
  Layers,
  Plus,
  Pencil,
  Trash2,
  X,
  FileText,
  List,
} from 'lucide-react';
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

const CATEGORIES = ['engineering', 'design', 'security', 'devops', 'data', 'ai', 'management', 'finance', 'science', 'other'];

const CATEGORY_COLORS: Record<string, string> = {
  engineering: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  design: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  security: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  devops: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  data: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  ai: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  management: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  finance: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
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
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
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
          className="flex-1 px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100"
        />
        <button
          type="button"
          onClick={handleAdd}
          className="px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer"
        >
          Add
        </button>
      </div>
      {items.length > 0 && (
        <div className="space-y-1">
          {items.map((item, i) => (
            <div key={i} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/50 rounded-lg px-3 py-1.5">
              <span className="flex-1">{item}</span>
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="text-gray-400 hover:text-red-500 cursor-pointer"
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
    <div className="flex rounded-lg bg-gray-100 dark:bg-gray-700 p-0.5">
      <button
        type="button"
        onClick={() => onChange('markdown')}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors',
          mode === 'markdown' ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400'
        )}
      >
        <FileText className="w-3.5 h-3.5" /> Markdown
      </button>
      <button
        type="button"
        onClick={() => onChange('structured')}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors',
          mode === 'structured' ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400'
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
  const [category, setCategory] = useState('engineering');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [principles, setPrinciples] = useState<string[]>([]);
  const [bestPractices, setBestPractices] = useState<string[]>([]);
  const [antiPatterns, setAntiPatterns] = useState<string[]>([]);
  const [frameworks, setFrameworks] = useState<string[]>([]);

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
      await api.post('/skills', {
        name: name.trim(),
        category,
        description: description.trim() || (mode === 'markdown' ? content.trim().split('\n')[0].replace(/^#\s*/, '').slice(0, 200) : ''),
        content: mode === 'markdown' ? content : '',
        principles: mode === 'structured' ? principles : [],
        bestPractices: mode === 'structured' ? bestPractices : [],
        antiPatterns: mode === 'structured' ? antiPatterns : [],
        frameworks: mode === 'structured' ? frameworks : [],
      });
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
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Create Skill</h2>
          <div className="flex items-center gap-3">
            <ModeToggle mode={mode} onChange={setMode} />
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Skill name"
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={mode === 'markdown' ? 'Short description (auto-generated from content if empty)' : 'Skill description'}
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100"
            />
          </div>

          {mode === 'markdown' ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Markdown Content
                <span className="ml-2 text-xs font-normal text-gray-400">Paste a Claude Code skill (.md) or write your own</span>
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={"# My Skill\n\nInstructions for the AI agent...\n\n## Guidelines\n- Do this\n- Don't do that\n\n## Examples\n..."}
                rows={16}
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100 resize-y font-mono"
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
              className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm bg-primary-800 text-white rounded-lg hover:bg-primary-900 disabled:opacity-50 cursor-pointer"
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
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit Skill</h2>
          <div className="flex items-center gap-3">
            <ModeToggle mode={mode} onChange={setMode} />
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Skill name"
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Skill description"
              className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100"
            />
          </div>

          {mode === 'markdown' ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Markdown Content
                <span className="ml-2 text-xs font-normal text-gray-400">Paste a Claude Code skill (.md) or write your own</span>
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={"# My Skill\n\nInstructions for the AI agent...\n\n## Guidelines\n- Do this\n- Don't do that"}
                rows={16}
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100 resize-y font-mono"
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
              className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm bg-primary-800 text-white rounded-lg hover:bg-primary-900 disabled:opacity-50 cursor-pointer"
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
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Delete Skill</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <p className="text-sm text-gray-700 dark:text-gray-300">
            Are you sure you want to delete <strong>{skill.name}</strong>? This action cannot be undone.
          </p>

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 cursor-pointer"
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
    <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between text-left cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <div className="text-gray-500">
            {expanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </div>
          <BookOpen className="w-5 h-5 text-primary-500" />
          <div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{skill.name}</h3>
            <p className="text-xs text-gray-500 mt-0.5">{skill.description}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={cn('px-2 py-0.5 text-xs rounded-full font-medium', getCategoryColor(skill.category))}>
            {skill.category}
          </span>
          {skill.content?.trim() && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/20 dark:text-violet-300">
              md
            </span>
          )}
          {skill.isSystem && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400">
              system
            </span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit(skill);
            }}
            className="p-1 text-gray-400 hover:text-primary-600 dark:hover:text-primary-400 cursor-pointer"
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
                className="p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                title="Delete skill"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-4">
          {skill.content?.trim() ? (
            <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-primary-500" />
                Markdown Content
              </h4>
              <pre className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 whitespace-pre-wrap font-mono overflow-x-auto max-h-96 overflow-y-auto">
                {skill.content}
              </pre>
            </div>
          ) : (
            <>
              {skill.principles.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1.5">
                    <Lightbulb className="w-4 h-4 text-yellow-500" />
                    Principles
                  </h4>
                  <ul className="space-y-1">
                    {skill.principles.map((p, i) => (
                      <li key={i} className="text-sm text-gray-600 dark:text-gray-400 pl-4 relative before:content-[''] before:absolute before:left-0 before:top-2 before:w-1.5 before:h-1.5 before:rounded-full before:bg-yellow-400">
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {skill.bestPractices.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1.5">
                    <ThumbsUp className="w-4 h-4 text-green-500" />
                    Best Practices
                  </h4>
                  <ul className="space-y-1">
                    {skill.bestPractices.map((p, i) => (
                      <li key={i} className="text-sm text-gray-600 dark:text-gray-400 pl-4 relative before:content-[''] before:absolute before:left-0 before:top-2 before:w-1.5 before:h-1.5 before:rounded-full before:bg-green-400">
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {skill.antiPatterns.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-red-500" />
                    Anti-Patterns
                  </h4>
                  <ul className="space-y-1">
                    {skill.antiPatterns.map((p, i) => (
                      <li key={i} className="text-sm text-gray-600 dark:text-gray-400 pl-4 relative before:content-[''] before:absolute before:left-0 before:top-2 before:w-1.5 before:h-1.5 before:rounded-full before:bg-red-400">
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {skill.frameworks.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1.5">
                    <Layers className="w-4 h-4 text-blue-500" />
                    Frameworks
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {skill.frameworks.map((f, i) => (
                      <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
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
        <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
          <BookOpen className="w-5 h-5 text-primary-700 dark:text-primary-400" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Skills</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {skills.length} domain knowledge skills across {categories.length} categories
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary-800 text-white rounded-lg hover:bg-primary-900 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Create Skill
        </button>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Skills are domain expertise sets — principles, best practices, and anti-patterns — that get injected into expert agent prompts for grounded, specialist-level responses.
      </p>

      {/* Search + Category filter */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search skills, principles, frameworks..."
            className="w-full pl-10 pr-4 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 dark:text-gray-100"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button
            onClick={() => setCategoryFilter(null)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors',
              !categoryFilter
                ? 'bg-primary-800 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
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
                  ? 'bg-primary-800 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Skills list */}
      {isLoading ? (
        <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-8 text-center text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
          Loading...
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-8 text-center">
          <BookOpen className="w-8 h-8 text-gray-500 mx-auto mb-2" />
          <p className="text-gray-500">No skills found</p>
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
