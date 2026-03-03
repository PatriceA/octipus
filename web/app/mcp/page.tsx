'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Cable,
  Plus,
  Trash2,
  Power,
  PowerOff,
  Loader2,
  X,
  ChevronDown,
  ChevronRight,
  Wrench,
  RefreshCw,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface MCPServer {
  id: string;
  name: string;
  command: string;
  args?: string[];
  transport: 'stdio' | 'sse';
  sseUrl?: string;
  isEnabled: boolean;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  error?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface AddServerModalProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

function AddServerModal({ open, onClose, onAdded }: AddServerModalProps) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'sse'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [sseUrl, setSseUrl] = useState('');
  const [postUrl, setPostUrl] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setIsSubmitting(true);
    setError('');

    try {
      const body: Record<string, unknown> = {
        name,
        transport,
        isEnabled: true,
      };

      if (transport === 'stdio') {
        body.command = command;
        body.args = args.split(/\s+/).filter(Boolean);
      } else {
        body.sseUrl = sseUrl;
        body.postUrl = postUrl;
      }

      await api.post('/mcp/servers', body);
      onAdded();
      onClose();
      setName('');
      setCommand('');
      setArgs('');
      setSseUrl('');
      setPostUrl('');
    } catch (err) {
      setError((err as Error).message);
    }

    setIsSubmitting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Add MCP Server</h2>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-600 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
              placeholder="e.g., Brave Search"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Transport</label>
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value as 'stdio' | 'sse')}
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
            >
              <option value="stdio">stdio (local process)</option>
              <option value="sse">SSE (remote server)</option>
            </select>
          </div>

          {transport === 'stdio' ? (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Command</label>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
                  placeholder="npx"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Arguments</label>
                <input
                  type="text"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
                  placeholder="-y @anthropic/brave-search-mcp"
                />
                <p className="mt-1 text-xs text-gray-500">Space-separated arguments</p>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SSE URL</label>
                <input
                  type="text"
                  value={sseUrl}
                  onChange={(e) => setSseUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
                  placeholder="http://localhost:8080/sse"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">POST URL</label>
                <input
                  type="text"
                  value={postUrl}
                  onChange={(e) => setPostUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200"
                  placeholder="http://localhost:8080/message"
                />
              </div>
            </>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !name.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 disabled:opacity-50 text-sm"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add Server
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ServerToolList({ serverId }: { serverId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['mcp-tools', serverId],
    queryFn: () => api.get<{ tools: MCPTool[] }>(`/mcp/servers/${serverId}/tools`),
  });

  if (isLoading) {
    return (
      <div className="py-2 px-4 text-sm text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading tools...
      </div>
    );
  }

  const tools = data?.tools || [];

  if (tools.length === 0) {
    return <p className="py-2 px-4 text-sm text-gray-500">No tools available</p>;
  }

  return (
    <div className="space-y-1 px-4 pb-3">
      {tools.map((tool) => (
        <div key={tool.name} className="flex items-start gap-2 py-1">
          <Wrench className="w-3.5 h-3.5 text-gray-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{tool.name}</p>
            <p className="text-xs text-gray-500">{tool.description}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function MCPPage() {
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: async () => {
      try {
        return await api.get<{ servers: MCPServer[] }>('/mcp/servers');
      } catch {
        return { servers: [] };
      }
    },
  });

  const servers = data?.servers || [];

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await api.post(`/mcp/servers/${id}/toggle`, { enabled: !enabled });
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch {}
  };

  const handleConnect = async (id: string) => {
    try {
      await api.post(`/mcp/servers/${id}/connect`);
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch {}
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this MCP server?')) return;
    try {
      await api.delete(`/mcp/servers/${id}`);
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch {}
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'connected':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
      case 'connecting':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
      case 'error':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
            <Cable className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">MCP Servers</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Manage Model Context Protocol servers and their tools</p>
          </div>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Add Server
        </button>
      </div>

      <div className="space-y-3">
        {isLoading ? (
          <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-8 text-center text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
            Loading...
          </div>
        ) : servers.length === 0 ? (
          <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-8 text-center">
            <Cable className="w-8 h-8 text-gray-500 mx-auto mb-2" />
            <p className="text-gray-500">No MCP servers configured</p>
            <p className="text-sm text-gray-500 mt-1">
              Add an MCP server to extend your assistant with external tools
            </p>
          </div>
        ) : (
          servers.map((server) => (
            <div
              key={server.id}
              className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60"
            >
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => toggleExpand(server.id)}
                      className="text-gray-500 hover:text-gray-600"
                    >
                      {expanded.has(server.id) ? (
                        <ChevronDown className="w-5 h-5" />
                      ) : (
                        <ChevronRight className="w-5 h-5" />
                      )}
                    </button>
                    <div>
                      <h3 className="font-medium text-gray-900 dark:text-gray-100">{server.name}</h3>
                      <p className="text-xs text-gray-500 font-mono">
                        {server.transport === 'sse'
                          ? server.sseUrl
                          : `${server.command} ${(server.args || []).join(' ')}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      {server.status === 'connected' && (
                        <span>{server.toolCount} tools</span>
                      )}
                    </div>
                    <span className={cn('px-2 py-0.5 text-xs rounded-full', statusColor(server.status))}>
                      {server.status}
                    </span>
                    {server.status === 'disconnected' && server.isEnabled && (
                      <button
                        onClick={() => handleConnect(server.id)}
                        className="p-1.5 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded cursor-pointer"
                        title="Connect"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => handleToggle(server.id, server.isEnabled)}
                      className={cn(
                        'p-1.5 rounded cursor-pointer',
                        server.isEnabled
                          ? 'text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20'
                          : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'
                      )}
                      title={server.isEnabled ? 'Disable' : 'Enable'}
                    >
                      {server.isEnabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => handleDelete(server.id)}
                      className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded cursor-pointer"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {server.error && (
                  <p className="mt-2 text-sm text-red-500">{server.error}</p>
                )}
              </div>

              {expanded.has(server.id) && server.status === 'connected' && (
                <div className="border-t border-gray-200 dark:border-gray-700">
                  <ServerToolList serverId={server.id} />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <AddServerModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => queryClient.invalidateQueries({ queryKey: ['mcp-servers'] })}
      />
    </div>
  );
}
