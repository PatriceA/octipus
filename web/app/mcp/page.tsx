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
  Eye,
  EyeOff,
  Zap,
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

type TransportType = 'streamable-http' | 'sse' | 'stdio';

function AddServerModal({ open, onClose, onAdded }: AddServerModalProps) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<TransportType>('streamable-http');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [authHeader, setAuthHeader] = useState('');
  const [showAuth, setShowAuth] = useState(false);
  const [envVars, setEnvVars] = useState('');
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
        if (!command.trim()) {
          setError('Command is required');
          setIsSubmitting(false);
          return;
        }
        body.command = command.trim();
        body.args = args.trim() ? args.trim().split(/\s+/) : [];

        // Parse env vars (KEY=VALUE per line)
        if (envVars.trim()) {
          const env: Record<string, string> = {};
          for (const line of envVars.split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0) {
              env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
            }
          }
          if (Object.keys(env).length > 0) body.env = env;
        }
      } else {
        if (!serverUrl.trim()) {
          setError('Server URL is required');
          setIsSubmitting(false);
          return;
        }

        if (transport === 'streamable-http') {
          // Streamable HTTP — single endpoint URL
          body.sseUrl = serverUrl.trim().replace(/\/$/, '');
        } else {
          // SSE — derive SSE and POST URLs from the base URL
          const baseUrl = serverUrl.trim().replace(/\/sse\/?$/, '').replace(/\/$/, '');
          body.sseUrl = `${baseUrl}/sse`;
          body.postUrl = baseUrl;
        }

        if (authHeader.trim()) {
          body.headers = { Authorization: authHeader.trim() };
        }
      }

      await api.post('/mcp/servers', body);
      onAdded();
      onClose();
      // Reset form
      setName('');
      setCommand('');
      setArgs('');
      setServerUrl('');
      setAuthHeader('');
      setEnvVars('');
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }

    setIsSubmitting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#1a1a1a] rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Add MCP Server</h2>
          <button onClick={onClose} className="p-1 text-on-surface-variant hover:text-white cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Transport toggle */}
          <div>
            <label className="block text-sm font-medium text-white/80 mb-1.5">Transport</label>
            <div className="flex gap-2">
              {([
                { value: 'streamable-http' as const, label: 'HTTP', desc: 'n8n, modern MCP' },
                { value: 'sse' as const, label: 'SSE', desc: 'legacy remote' },
                { value: 'stdio' as const, label: 'stdio', desc: 'npm packages' },
              ] as const).map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTransport(t.value)}
                  className={cn(
                    'flex-1 px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer',
                    transport === t.value
                      ? 'bg-primary-800 text-white border-primary-800'
                      : 'bg-[#131313] text-on-surface-variant border-outline-variant/10 hover:border-outline-variant/30'
                  )}
                >
                  {t.label}
                  <span className="block text-[10px] opacity-70 mt-0.5">{t.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-white/80 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-[#131313] border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary/40 focus:border-primary text-white"
              placeholder={transport === 'sse' ? 'e.g., n8n Workflows' : 'e.g., Brave Search'}
            />
          </div>

          {transport !== 'stdio' ? (
            <>
              {/* Server URL */}
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1">Server URL</label>
                <input
                  type="text"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-[#131313] border border-outline-variant/10 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary/40 focus:border-primary text-white"
                  placeholder={transport === 'streamable-http'
                    ? 'https://n8n.example.com/mcp-server/http'
                    : 'http://localhost:5678/mcp/your-path'}
                />
                {transport === 'sse' && (
                  <p className="mt-1 text-xs text-on-surface-variant">/sse is appended automatically for the SSE endpoint</p>
                )}
              </div>

              {/* Authorization header */}
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1">
                  Authorization Header
                  <span className="text-on-surface-variant font-normal ml-1">(optional)</span>
                </label>
                <div className="relative">
                  <input
                    type={showAuth ? 'text' : 'password'}
                    value={authHeader}
                    onChange={(e) => setAuthHeader(e.target.value)}
                    className="w-full px-3 py-2 pr-10 bg-[#131313] border border-outline-variant/10 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary/40 focus:border-primary text-white"
                    placeholder="Bearer eyJhbGci..."
                  />
                  <button
                    type="button"
                    onClick={() => setShowAuth(!showAuth)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-white cursor-pointer"
                  >
                    {showAuth ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Command */}
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1">Command</label>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className="w-full px-3 py-2 bg-[#131313] border border-outline-variant/10 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary/40 focus:border-primary text-white"
                  placeholder="npx"
                />
              </div>

              {/* Arguments */}
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1">Arguments</label>
                <input
                  type="text"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  className="w-full px-3 py-2 bg-[#131313] border border-outline-variant/10 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary/40 focus:border-primary text-white"
                  placeholder="-y @anthropic/brave-search-mcp"
                />
                <p className="mt-1 text-xs text-on-surface-variant">Space-separated arguments</p>
              </div>

              {/* Environment variables */}
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1">
                  Environment Variables
                  <span className="text-on-surface-variant font-normal ml-1">(optional)</span>
                </label>
                <textarea
                  value={envVars}
                  onChange={(e) => setEnvVars(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 bg-[#131313] border border-outline-variant/10 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary/40 focus:border-primary text-white resize-none"
                  placeholder={"BRAVE_API_KEY=your-key-here\nANOTHER_VAR=value"}
                />
                <p className="mt-1 text-xs text-on-surface-variant">One KEY=VALUE per line</p>
              </div>
            </>
          )}

          {error && <p className="text-sm text-[#ff716c]">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-on-surface-variant hover:text-white cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting || !name.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-primary-800 text-white cursor-pointer rounded-lg hover:bg-primary-900 disabled:opacity-50 text-sm"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add & Connect
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
      <div className="py-3 px-4 text-sm text-on-surface-variant">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading tools...
      </div>
    );
  }

  const tools = data?.tools || [];

  if (tools.length === 0) {
    return <p className="py-3 px-4 text-sm text-on-surface-variant">No tools available</p>;
  }

  return (
    <div className="space-y-1 px-4 py-3">
      <p className="text-[10px] font-medium text-on-surface-variant uppercase tracking-wider mb-2">
        Available Tools ({tools.length})
      </p>
      {tools.map((tool) => (
        <div key={tool.name} className="flex items-start gap-2 px-2.5 py-1.5 bg-[#131313] rounded-lg">
          <Wrench className="w-3.5 h-3.5 text-on-surface-variant mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-mono font-medium text-white/80">{tool.name}</p>
            <p className="text-xs text-on-surface-variant leading-tight">{tool.description}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function MCPPage() {
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState<string | null>(null);
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
    refetchInterval: 10000,
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

  const handleToggle = async (id: string, currentlyEnabled: boolean) => {
    setActionLoading(id);
    try {
      await api.post(`/mcp/servers/${id}/toggle`, { enabled: !currentlyEnabled });
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch {}
    setActionLoading(null);
  };

  const handleConnect = async (id: string) => {
    setActionLoading(id);
    try {
      await api.post(`/mcp/servers/${id}/connect`);
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch {}
    setActionLoading(null);
  };

  const handleDisconnect = async (id: string) => {
    setActionLoading(id);
    try {
      await api.post(`/mcp/servers/${id}/disconnect`);
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch {}
    setActionLoading(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this MCP server?')) return;
    setActionLoading(id);
    try {
      await api.delete(`/mcp/servers/${id}`);
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch {}
    setActionLoading(null);
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'connected':
        return 'bg-green-900/30 text-green-300';
      case 'connecting':
        return 'bg-yellow-900/30 text-yellow-300';
      case 'error':
        return 'bg-red-900/30 text-red-300';
      default:
        return 'bg-[#262626] text-on-surface-variant';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Cable className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">MCP Servers</h1>
            <p className="text-sm text-on-surface-variant">
              Connect external tools via Model Context Protocol. Agents discover tools on demand.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-primary-800 text-white cursor-pointer rounded-lg hover:bg-primary-900 flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Add Server
        </button>
      </div>

      <div className="space-y-3">
        {isLoading ? (
          <div className="bg-[#1a1a1a] rounded-[1rem] ring-1 ring-outline-variant/10 p-8 text-center text-on-surface-variant">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
            Loading...
          </div>
        ) : servers.length === 0 ? (
          <div className="bg-[#1a1a1a] rounded-[1rem] ring-1 ring-outline-variant/10 p-8 text-center">
            <Cable className="w-8 h-8 text-on-surface-variant mx-auto mb-2" />
            <p className="text-on-surface-variant">No MCP servers configured</p>
            <p className="text-sm text-on-surface-variant mt-1">
              Add servers like n8n, Brave Search, or any MCP-compatible service
            </p>
          </div>
        ) : (
          servers.map((server) => (
            <div
              key={server.id}
              className="bg-[#1a1a1a] rounded-[1rem] ring-1 ring-outline-variant/10"
            >
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <button
                      onClick={() => toggleExpand(server.id)}
                      className="text-on-surface-variant hover:text-white shrink-0"
                    >
                      {expanded.has(server.id) ? (
                        <ChevronDown className="w-5 h-5" />
                      ) : (
                        <ChevronRight className="w-5 h-5" />
                      )}
                    </button>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-white truncate">{server.name}</h3>
                        <span className={cn('px-2 py-0.5 text-[10px] font-medium rounded-full shrink-0', statusColor(server.status))}>
                          {server.status}
                        </span>
                        <span className="px-1.5 py-0.5 text-[10px] text-on-surface-variant bg-[#262626] rounded font-mono shrink-0">
                          {server.transport}
                        </span>
                        {server.status === 'connected' && server.toolCount > 0 && (
                          <span className="flex items-center gap-0.5 text-[10px] text-on-surface-variant shrink-0">
                            <Wrench className="w-3 h-3" />
                            {server.toolCount}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-on-surface-variant font-mono truncate mt-0.5">
                        {server.transport === 'sse'
                          ? server.sseUrl
                          : `${server.command} ${(server.args || []).join(' ')}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 ml-3">
                    {actionLoading === server.id ? (
                      <Loader2 className="w-4 h-4 animate-spin text-on-surface-variant" />
                    ) : (
                      <>
                        {/* Enable/disable */}
                        <button
                          onClick={() => handleToggle(server.id, server.isEnabled)}
                          className={cn(
                            'p-1.5 rounded-lg transition-colors cursor-pointer',
                            server.isEnabled
                              ? 'text-green-600 hover:bg-green-900/20'
                              : 'text-on-surface-variant hover:bg-[#1a1a1a]'
                          )}
                          title={server.isEnabled ? 'Disable' : 'Enable'}
                        >
                          {server.isEnabled ? <Zap className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                        </button>

                        {/* Connect */}
                        {server.isEnabled && server.status !== 'connected' && server.status !== 'connecting' && (
                          <button
                            onClick={() => handleConnect(server.id)}
                            className="p-1.5 text-blue-600 hover:bg-blue-900/20 rounded-lg cursor-pointer"
                            title="Connect"
                          >
                            <Power className="w-4 h-4" />
                          </button>
                        )}

                        {/* Disconnect */}
                        {server.status === 'connected' && (
                          <button
                            onClick={() => handleDisconnect(server.id)}
                            className="p-1.5 text-on-surface-variant hover:bg-[#1a1a1a] rounded-lg cursor-pointer"
                            title="Disconnect"
                          >
                            <PowerOff className="w-4 h-4" />
                          </button>
                        )}

                        {/* Delete */}
                        <button
                          onClick={() => handleDelete(server.id)}
                          className="p-1.5 text-on-surface-variant hover:text-red-500 hover:bg-red-900/20 rounded-lg cursor-pointer"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {server.error && (
                  <p className="mt-2 ml-8 text-xs text-red-500">{server.error}</p>
                )}
              </div>

              {expanded.has(server.id) && server.status === 'connected' && (
                <div className="border-t border-outline-variant/10">
                  <ServerToolList serverId={server.id} />
                </div>
              )}
              {expanded.has(server.id) && server.status !== 'connected' && (
                <div className="border-t border-outline-variant/10 px-4 py-3">
                  <p className="text-xs text-on-surface-variant ml-8">Connect to view available tools</p>
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
