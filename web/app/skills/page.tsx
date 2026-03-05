'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Skill {
  id: string;
  name: string;
  category: string;
  description: string;
  principles: string[];
  bestPractices: string[];
  antiPatterns: string[];
  frameworks: string[];
  isSystem: boolean;
}

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

function SkillCard({ skill }: { skill: Skill }) {
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
          {skill.isSystem && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400">
              system
            </span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-4">
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
        </div>
      )}
    </div>
  );
}

export default function SkillsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

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
      s.principles.some((p) => p.toLowerCase().includes(q)) ||
      s.frameworks.some((f) => f.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
          <BookOpen className="w-5 h-5 text-primary-600 dark:text-primary-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Skills</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {skills.length} domain knowledge skills across {categories.length} categories
          </p>
        </div>
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
                ? 'bg-primary-600 text-white'
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
                  ? 'bg-primary-600 text-white'
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
            <SkillCard key={skill.id} skill={skill} />
          ))}
        </div>
      )}
    </div>
  );
}
