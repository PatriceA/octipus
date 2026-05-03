/**
 * Root <App> for the TUI editor.
 *
 * Owns the singleton stores, instantiates the gateway client, and
 * mounts <Layout>. Mirrors the contract of `src/tui/app.tsx`'s
 * `TuiApp` so a future "switch surface" command can swap in.
 */
import { randomBytes } from 'node:crypto';
import { useEffect, useState } from 'react';
import { GatewayClient } from '../tui/gateway-client';
import { ApiClient } from './api-client';
import { Layout } from './components/layout';
import { loadPersistedState, savePersistedState } from './persist';
import { AgentStore } from './stores/agent-store';
import { BufferStore } from './stores/buffer-store';
import { LayoutStore } from './stores/layout-store';
import { WorkspaceStore } from './stores/workspace-store';
import { setTheme } from './theme';
import { readFileForBuffer } from './workspace-fs-bridge';

// Shared singletons. Exported so components can import directly.
export const layoutStore = new LayoutStore();
export const bufferStore = new BufferStore();
export const agentStore = new AgentStore();
export const workspaceStore = new WorkspaceStore();
export const apiClient = new ApiClient({
  baseUrl: 'http://localhost:3015/api',
  workspaceStore,
});

interface Props {
  gatewayUrl?: string;
  projectPath?: string;
}

function newSessionId(): string {
  const hex = randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function TuiEditorApp({ gatewayUrl, projectPath }: Props) {
  const [sessionId] = useState(newSessionId);
  const [client] = useState(() => new GatewayClient({
    url: gatewayUrl,
    getWorkspace: () => workspaceStore.get().activeSlug,
    onStatusChange: (s) => agentStore.setStatus(s),
    onResponse: (response) => {
      agentStore.pushMessage('assistant', response);
    },
    onCommandResult: (name, result, error) => {
      const content = error || (typeof result === 'string' ? result : JSON.stringify(result));
      agentStore.pushMessage('system', `/${name}: ${content}`);
    },
    onEvent: (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (event.type === 'permission.request') {
        const p = (payload ?? {}) as { requestId?: string; toolName?: string; action?: string; args?: Record<string, unknown> };
        const toolName = p.toolName ?? p.action ?? 'unknown';
        let detail = toolName;
        const args = p.args;
        if (args) {
          const path = args.path || args.file_path || args.filename;
          const command = args.command;
          if (path) detail = `${toolName} → ${path}`;
          else if (command) {
            const cmd = String(command);
            detail = `${toolName} → ${cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd}`;
          }
        }
        agentStore.setPendingPermission({ requestId: p.requestId ?? '', toolName, detail });
        return;
      }
      if (event.type === 'agent.spawned') {
        agentStore.setAgentRunning(true);
        const data = (payload ?? {}) as { role?: string; model?: string; data?: { role?: string; model?: string } };
        const role = data.role ?? data.data?.role ?? 'worker';
        const model = data.model ?? data.data?.model ?? '';
        agentStore.setLastStats({ role, model });
        agentStore.pushMessage('system', `Agent spawned: ${role}${model ? ` (${model})` : ''}`);
        return;
      }
      if (event.type === 'agent.completed') {
        agentStore.setAgentRunning(false);
        agentStore.setCurrentTool(null);
        const stats = (payload ?? {}) as { stats?: { totalTokens?: number; totalCostUsd?: number; durationMs?: number }; data?: { totalTokens?: number; totalCostUsd?: number; durationMs?: number } };
        const s = stats.stats ?? stats.data;
        if (s) {
          const tokens = s.totalTokens ?? 0;
          const cost = s.totalCostUsd ?? 0;
          agentStore.setLastStats({ tokens, durationMs: s.durationMs, costUsd: cost });
          agentStore.addRun({ tokens, cost });
        }
        agentStore.pushMessage('system', 'Agent completed.');
        return;
      }
      if (event.type === 'agent.action') {
        const data = (payload ?? {}) as { data?: { type?: string; toolName?: string; tool_name?: string; output?: string; error?: unknown; isError?: unknown }; type?: string; toolName?: string };
        const inner = data.data ?? (data as Record<string, unknown>);
        const type = (inner as { type?: string }).type;
        if (type === 'tool_call' || type === 'cli_tool_use') {
          const name = (inner as { toolName?: string; tool_name?: string }).toolName
            ?? (inner as { tool_name?: string }).tool_name ?? 'tool';
          agentStore.setCurrentTool({ name, state: 'pending', startedAt: Date.now() });
          setTimeout(() => agentStore.patchCurrentTool({ state: 'executing' }), 100);
        }
        if (type === 'cli_tool_result' || type === 'tool_result') {
          const out = (inner as { output?: string }).output;
          const err = (inner as { error?: unknown; isError?: unknown });
          const isError = !!(err.error || err.isError);
          const preview = typeof out === 'string' ? out.split('\n')[0]?.slice(0, 80) : undefined;
          agentStore.patchCurrentTool({ state: isError ? 'error' : 'completed', preview });
          setTimeout(() => agentStore.setCurrentTool(null), 1500);
        }
        return;
      }
      if (event.type === 'chat.response') {
        const p = (payload ?? {}) as { response?: { response?: string } | string };
        const text = typeof p.response === 'string' ? p.response : p.response?.response;
        if (text) agentStore.pushMessage('assistant', text);
      }
    },
    onError: (error) => {
      agentStore.pushMessage('system', `Error: ${error}`);
    },
  }));

  useEffect(() => {
    if (projectPath) workspaceStore.setProjectRoot(projectPath);

    // Load persisted layout state. Restoring buffers happens after
    // we know the project root so paths under it stay valid.
    const persisted = loadPersistedState();
    setTheme(persisted.theme);
    layoutStore.setEditorMode(persisted.editorMode);
    if (!persisted.treeVisible) layoutStore.toggleTree();
    if (!persisted.chatVisible) layoutStore.toggleChat();
    for (const path of persisted.openPaths) {
      const text = readFileForBuffer(path);
      if (text !== null) bufferStore.openFile(path, text);
    }
    if (persisted.activePath) {
      const rec = bufferStore.findByPath(persisted.activePath);
      if (rec) bufferStore.setActive(rec.id);
    }

    client.connect();

    // Fetch workspaces — passes X-Octipus-Workspace via apiClient.
    // Failure is silent (single-user installs don't have the route).
    apiClient.getJson<{ workspaces: { id: string; slug: string; name: string; isDefault: boolean }[] }>(
      '/me/workspaces',
    ).then((data) => {
      if (data?.workspaces) workspaceStore.setAvailable(data.workspaces);
    });

    // Track terminal size for scroll math.
    const updateSize = () => layoutStore.setSize(process.stdout.columns ?? 120, process.stdout.rows ?? 30);
    updateSize();
    process.stdout.on('resize', updateSize);

    // Persist on every layout / buffer / theme / workspace change.
    // Debounce so a burst of keystrokes doesn't churn disk.
    let saveTimer: NodeJS.Timeout | null = null;
    const queueSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        savePersistedState({
          version: 1,
          openPaths: bufferStore.get().buffers
            .map((b) => b.path)
            .filter((p): p is string => typeof p === 'string'),
          activePath: bufferStore.active()?.path ?? null,
          treeVisible: layoutStore.get().treeVisible,
          chatVisible: layoutStore.get().chatVisible,
          theme: 'dark', // theme changes don't go through a store yet; conservative default
          editorMode: layoutStore.get().editorMode,
        });
      }, 500);
    };
    const offLayout = layoutStore.subscribe(queueSave);
    const offBuffers = bufferStore.subscribe(queueSave);

    return () => {
      offLayout();
      offBuffers();
      if (saveTimer) clearTimeout(saveTimer);
      process.stdout.off('resize', updateSize);
      client.disconnect();
    };
  }, [client, projectPath]);

  return <Layout client={client} sessionId={sessionId} />;
}
