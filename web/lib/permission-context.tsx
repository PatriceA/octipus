'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { createAuthenticatedWebSocket } from './api';
import { useAuth } from './auth-context';
import { api } from './api';

export interface PermissionRequest {
  requestId: string;
  skillId: string;
  action: string;
  args?: Record<string, unknown>;
}

export interface ApprovalRequest {
  requestId: string;
  summary: string;
  question: string;
  options?: string[];
}

interface PermissionContextValue {
  /** Currently pending permission requests (tool permissions) */
  permissions: PermissionRequest[];
  /** Currently pending approval requests (pipeline/orchestrator approvals) */
  approvals: ApprovalRequest[];
  /** Approve a permission request */
  approvePermission: (requestId: string) => void;
  /** Deny a permission request */
  denyPermission: (requestId: string) => void;
  /** Approve an approval request, optionally with a selected option */
  approveApproval: (requestId: string, response?: string) => void;
  /** Deny an approval request */
  denyApproval: (requestId: string) => void;
  /** Push approval from an external WS (e.g. the chat page's /ws connection) */
  pushApproval: (approval: ApprovalRequest) => void;
  /** Push permission from an external WS (e.g. the chat page's /ws connection) */
  pushPermission: (permission: PermissionRequest) => void;
}

const PermissionContext = createContext<PermissionContextValue>({
  permissions: [],
  approvals: [],
  approvePermission: () => {},
  denyPermission: () => {},
  approveApproval: () => {},
  denyApproval: () => {},
  pushApproval: () => {},
  pushPermission: () => {},
});

export function usePermissions() {
  return useContext(PermissionContext);
}

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);

  // WebSocket ref for /ws/permissions
  const permWsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);

  // Respond to a permission request via the /ws/permissions endpoint
  const respondPermission = useCallback((requestId: string, approved: boolean) => {
    const ws = permWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'respond',
        requestId,
        approved,
      }));
    }
    setPermissions(prev => prev.filter(p => p.requestId !== requestId));
  }, []);

  // Respond to an approval request via HTTP
  const respondApproval = useCallback((requestId: string, approved: boolean, response?: string) => {
    api.post('/chat/approve', { requestId, approved, response }).catch(console.error);
    setApprovals(prev => prev.filter(a => a.requestId !== requestId));
  }, []);

  const approvePermission = useCallback((requestId: string) => {
    respondPermission(requestId, true);
  }, [respondPermission]);

  const denyPermission = useCallback((requestId: string) => {
    respondPermission(requestId, false);
  }, [respondPermission]);

  const approveApproval = useCallback((requestId: string, response?: string) => {
    respondApproval(requestId, true, response);
  }, [respondApproval]);

  const denyApproval = useCallback((requestId: string) => {
    respondApproval(requestId, false);
  }, [respondApproval]);

  // Push methods for external WS connections (e.g. chat page) to forward events
  const pushApproval = useCallback((approval: ApprovalRequest) => {
    setApprovals(prev => {
      if (prev.some(a => a.requestId === approval.requestId)) return prev;
      return [...prev, approval];
    });
  }, []);

  const pushPermission = useCallback((permission: PermissionRequest) => {
    setPermissions(prev => {
      if (prev.some(p => p.requestId === permission.requestId)) return prev;
      return [...prev, permission];
    });
  }, []);

  // Poll for pending approvals (works from any page, no /ws conflict)
  const pollApprovals = useCallback(async () => {
    try {
      const res = await api.get<{ approvals: ApprovalRequest[] }>('/chat/approvals/pending');
      if (res?.approvals?.length) {
        setApprovals(prev => {
          const existingIds = new Set(prev.map(a => a.requestId));
          const newApprovals = res.approvals.filter(a => !existingIds.has(a.requestId));
          return newApprovals.length > 0 ? [...prev, ...newApprovals] : prev;
        });
      } else {
        // No pending approvals on backend — clear any stale ones in state
        setApprovals(prev => prev.length > 0 ? [] : prev);
      }
    } catch { /* ignore */ }
  }, []);

  // /ws/permissions connection — handles tool permission requests
  useEffect(() => {
    if (!isAuthenticated) return;

    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;

      try {
        const ws = await createAuthenticatedWebSocket('/ws/permissions');
        if (cancelled) {
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        permWsRef.current = ws;

        ws.onopen = () => {
          reconnectDelayRef.current = 1000;
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            if (data.type === 'pending_requests') {
              // Initial batch of pending requests on connect
              const reqs: PermissionRequest[] = (data.requests || []).map((r: any) => ({
                requestId: r.id || r.requestId,
                skillId: r.skillId || r.toolId || '',
                action: r.action || r.toolName || '',
                args: r.args || r.context,
              }));
              if (reqs.length > 0) {
                setPermissions(prev => {
                  const existingIds = new Set(prev.map(p => p.requestId));
                  const newReqs = reqs.filter(r => !existingIds.has(r.requestId));
                  return newReqs.length > 0 ? [...prev, ...newReqs] : prev;
                });
              }
            } else if (data.type === 'permission_request') {
              // Live request emitted while we were already connected
              const req: PermissionRequest = {
                requestId: data.requestId,
                skillId: data.skillId || data.toolId || '',
                action: data.action || data.toolName || '',
                args: data.args,
              };
              if (req.requestId) {
                setPermissions(prev => {
                  if (prev.some(p => p.requestId === req.requestId)) return prev;
                  return [...prev, req];
                });
              }
            } else if (data.type === 'response_recorded') {
              // A response was recorded — remove from our list
              setPermissions(prev => prev.filter(p => p.requestId !== data.requestId));
            }
          } catch { /* ignore parse errors */ }
        };

        ws.onclose = () => {
          if (cancelled) return;
          permWsRef.current = null;
          reconnectTimerRef.current = setTimeout(() => {
            reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 1.5, 30000);
            connect();
          }, reconnectDelayRef.current);
        };

        ws.onerror = () => { /* onclose will handle reconnect */ };
      } catch {
        if (!cancelled) {
          reconnectTimerRef.current = setTimeout(connect, reconnectDelayRef.current);
        }
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (permWsRef.current) {
        permWsRef.current.onclose = null;
        permWsRef.current.close();
        permWsRef.current = null;
      }
    };
  }, [isAuthenticated]);

  // Poll for approvals every 5s (fast enough for responsiveness, avoids /ws conflicts)
  useEffect(() => {
    if (!isAuthenticated) return;

    // Initial poll
    pollApprovals();

    const interval = setInterval(pollApprovals, 5_000);
    return () => clearInterval(interval);
  }, [isAuthenticated, pollApprovals]);

  return (
    <PermissionContext.Provider value={{
      permissions,
      approvals,
      approvePermission,
      denyPermission,
      approveApproval,
      denyApproval,
      pushApproval,
      pushPermission,
    }}>
      {children}
    </PermissionContext.Provider>
  );
}
