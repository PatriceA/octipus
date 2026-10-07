'use client';

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import { useGateway, useGatewayMessages } from './gateway-context';
import type { GatewayMessage } from './gateway';

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
  /** Currently pending approval requests (pipeline/root agent approvals) */
  approvals: ApprovalRequest[];
  /** Approve a permission request */
  approvePermission: (requestId: string, resolution?: string) => void;
  /** Deny a permission request */
  denyPermission: (requestId: string) => void;
  /** Approve an approval request, optionally with a selected option */
  approveApproval: (requestId: string, response?: string) => void;
  /** Deny an approval request */
  denyApproval: (requestId: string) => void;
  /** Why the last answer was refused (e.g. the request expired), until dismissed */
  approvalNotice: string | null;
  dismissApprovalNotice: () => void;
}

const PermissionContext = createContext<PermissionContextValue>({
  permissions: [],
  approvals: [],
  approvePermission: () => {},
  denyPermission: () => {},
  approveApproval: () => {},
  denyApproval: () => {},
  approvalNotice: null,
  dismissApprovalNotice: () => {},
});

export function usePermissions() {
  return useContext(PermissionContext);
}

/** Gateway error codes that answer this tab's approval or permission response. */
const ANSWER_ERRORS = new Set(['APPROVAL_EXPIRED', 'APPROVAL_NOT_FOUND', 'APPROVAL_ERROR', 'PERMISSION_ERROR']);

/** Not connected: the answer cannot be sent, and the prompt stays up. */
const OFFLINE_NOTICE = 'Not connected to the server — your answer was not sent. It will be possible again once the connection is back.';

/**
 * The user's open tool-permission requests and root-agent approvals, kept in
 * step over the tab's gateway connection: the `permission.pending` snapshot
 * (after every (re)subscribe) replaces the lists, live `permission.request` /
 * `agent.approval_required` add to them, and `permission.resolved` /
 * `approval.resolved` remove from them — whichever tab or channel answered.
 */
export function PermissionProvider({ children }: { children: ReactNode }) {
  const client = useGateway();
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);
  const dismissApprovalNotice = useCallback(() => setApprovalNotice(null), []);

  // A late duplicate (a live request that also made it into a snapshot)
  // must not resurrect a decision already resolved. Retained across reconnects.
  const resolved = useRef(new Set<string>());
  const rememberResolution = useCallback((requestId: string) => {
    const set = resolved.current;
    set.add(requestId);
    if (set.size > 2000) set.delete(set.values().next().value!);
  }, []);

  useGatewayMessages((message: GatewayMessage) => {
    if (message.type === 'permission.pending') {
      // Authoritative: a reconnect drops entries resolved while it was down.
      setPermissions(message.requests
        .filter((r) => !resolved.current.has(r.requestId))
        .map((r) => ({ requestId: r.requestId, skillId: r.toolId, action: r.action || r.toolName, args: r.args })));
      setApprovals(message.approvals
        .filter((a) => !resolved.current.has(a.requestId))
        .map((a) => ({ requestId: a.requestId, summary: a.summary, question: a.question, options: a.options })));
      return;
    }
    if (message.type === 'error') {
      if (ANSWER_ERRORS.has(message.code)) setApprovalNotice(message.message);
      return;
    }
    if (message.type !== 'event') return;
    const { event } = message;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    if (!requestId) return;
    switch (event.type) {
      case 'permission.request': {
        const request: PermissionRequest = {
          requestId,
          skillId: String(payload.toolId ?? ''),
          action: String(payload.action ?? payload.toolName ?? ''),
          args: payload.args as Record<string, unknown> | undefined,
        };
        setPermissions((prev) => resolved.current.has(requestId) || prev.some((p) => p.requestId === requestId) ? prev : [...prev, request]);
        break;
      }
      case 'permission.resolved':
        rememberResolution(requestId);
        setPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
        break;
      case 'agent.approval_required': {
        const approval: ApprovalRequest = {
          requestId,
          summary: String(payload.summary ?? ''),
          question: String(payload.question ?? ''),
          options: Array.isArray(payload.options) ? payload.options.map(String) : undefined,
        };
        setApprovals((prev) => resolved.current.has(requestId) || prev.some((a) => a.requestId === requestId) ? prev : [...prev, approval]);
        break;
      }
      case 'approval.resolved':
        rememberResolution(requestId);
        setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
        break;
    }
  });

  // The authoritative `permission.resolved` / `approval.resolved` removes the
  // row; a refusal comes back as an error frame and shows as the notice.
  const respondPermission = useCallback((requestId: string, approved: boolean, resolution?: string) => {
    if (!client.send({ type: 'permission.respond', requestId, approved, ...(resolution === undefined ? {} : { resolution }) })) setApprovalNotice(OFFLINE_NOTICE);
  }, [client]);

  const respondApproval = useCallback((requestId: string, approved: boolean, response?: string) => {
    const sent = client.send({ type: 'approval.respond', requestId, approved, response: response ?? (approved ? 'approved' : 'denied') });
    if (!sent) setApprovalNotice(OFFLINE_NOTICE);
  }, [client]);

  const approvePermission = useCallback((requestId: string, resolution?: string) => respondPermission(requestId, true, resolution), [respondPermission]);
  const denyPermission = useCallback((requestId: string) => respondPermission(requestId, false), [respondPermission]);
  const approveApproval = useCallback((requestId: string, response?: string) => respondApproval(requestId, true, response), [respondApproval]);
  const denyApproval = useCallback((requestId: string) => respondApproval(requestId, false), [respondApproval]);

  return (
    <PermissionContext.Provider value={{
      permissions,
      approvals,
      approvePermission,
      denyPermission,
      approveApproval,
      denyApproval,
      approvalNotice,
      dismissApprovalNotice,
    }}>
      {children}
    </PermissionContext.Provider>
  );
}
