'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Play, Pause, RefreshCw, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

interface RecurringTask {
  id: string;
  name: string;
  description: string | null;
  cronExpression: string;
  timezone: string;
  actionType: string;
  actionConfig: Record<string, unknown>;
  isEnabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  lastError: string | null;
  status: string;
  createdAt: string;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<RecurringTask[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newTask, setNewTask] = useState({
    name: '',
    description: '',
    cronExpression: '',
    actionType: 'spawn_agent',
    agentPrompt: '',
    agentRole: 'general',
  });

  const loadTasks = useCallback(async () => {
    try {
      const data = await api.get<{ tasks: RecurringTask[] }>('/recurring-tasks');
      if (data?.tasks) setTasks(data.tasks);
    } catch {}
  }, []);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const createTask = async () => {
    if (!newTask.name || !newTask.cronExpression) return;
    try {
      await api.post('/recurring-tasks', {
        name: newTask.name,
        description: newTask.description || undefined,
        cronExpression: newTask.cronExpression,
        actionType: newTask.actionType,
        actionConfig: {
          agentPrompt: newTask.agentPrompt,
          agentRole: newTask.agentRole,
        },
      });
      setShowCreate(false);
      setNewTask({ name: '', description: '', cronExpression: '', actionType: 'spawn_agent', agentPrompt: '', agentRole: 'general' });
      loadTasks();
    } catch {}
  };

  const toggleTask = async (id: string, isEnabled: boolean) => {
    await api.patch(`/recurring-tasks/${id}`, { isEnabled: !isEnabled });
    loadTasks();
  };

  const deleteTask = async (id: string) => {
    await api.delete(`/recurring-tasks/${id}`);
    loadTasks();
  };

  const formatDate = (d: string | null) => {
    if (!d) return '—';
    return new Date(d).toLocaleString();
  };

  const cronPresets = [
    { label: 'Every 30 min', value: '*/30 * * * *' },
    { label: 'Every hour', value: '0 * * * *' },
    { label: 'Every 3 hours', value: '0 */3 * * *' },
    { label: 'Daily 9am', value: '0 9 * * *' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Recurring Tasks</h1>
          <p className="text-sm text-gray-500 mt-1">Schedule tasks to run automatically on a cron schedule.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={loadTasks} className="p-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">
            <RefreshCw className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            <Plus className="w-4 h-4" /> New Task
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Task name"
              value={newTask.name}
              onChange={(e) => setNewTask({ ...newTask, name: e.target.value })}
              className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
            />
            <div className="flex gap-2">
              <input
                placeholder="Cron expression (e.g., */30 * * * *)"
                value={newTask.cronExpression}
                onChange={(e) => setNewTask({ ...newTask, cronExpression: e.target.value })}
                className="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm font-mono"
              />
            </div>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {cronPresets.map((p) => (
              <button
                key={p.value}
                onClick={() => setNewTask({ ...newTask, cronExpression: p.value })}
                className={cn(
                  'px-2 py-1 text-xs rounded-md border',
                  newTask.cronExpression === p.value
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600'
                    : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            placeholder="What should the agent do?"
            value={newTask.agentPrompt}
            onChange={(e) => setNewTask({ ...newTask, agentPrompt: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
            rows={2}
          />
          <div className="flex gap-2">
            <select
              value={newTask.agentRole}
              onChange={(e) => setNewTask({ ...newTask, agentRole: e.target.value })}
              className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
            >
              <option value="general">General</option>
              <option value="research">Research</option>
              <option value="coding">Coding</option>
              <option value="communication">Communication</option>
            </select>
            <button onClick={createTask} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
              Create
            </button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-gray-600 dark:text-gray-400 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Tasks table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 overflow-hidden">
        {tasks.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No recurring tasks configured.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Name</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Schedule</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Status</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Last Run</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Next Run</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Runs</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600 dark:text-gray-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {tasks.map((task) => (
                <tr key={task.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{task.name}</div>
                    {task.description && <div className="text-xs text-gray-500 mt-0.5">{task.description}</div>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">{task.cronExpression}</td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                      task.status === 'active' && task.isEnabled ? 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400' :
                      task.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400' :
                      'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
                    )}>
                      {task.isEnabled ? task.status : 'paused'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{formatDate(task.lastRunAt)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{formatDate(task.nextRunAt)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{task.runCount}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() => toggleTask(task.id, task.isEnabled)}
                        className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"
                        title={task.isEnabled ? 'Pause' : 'Resume'}
                      >
                        {task.isEnabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => deleteTask(task.id)}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500"
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
        {tasks.some(t => t.lastError) && (
          <div className="border-t border-gray-100 dark:border-gray-700 p-3">
            {tasks.filter(t => t.lastError).map(t => (
              <div key={t.id} className="text-xs text-red-600 dark:text-red-400">
                {t.name}: {t.lastError}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
