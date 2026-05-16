'use client';

import { CheckCircle, ChevronDown, ChevronUp, Clock, Shield, Square, XCircle } from 'lucide-react';
import { useState } from 'react';
import { type ApprovalRequest, type PermissionRequest, usePermissions } from '@/lib/permission-context';

export function GlobalPermissionBanner() {
  const {
    permissions,
    approvals,
    approvePermission,
    denyPermission,
    approveApproval,
    denyApproval,
  } = usePermissions();

  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Show most recent permission or approval
  const latestPermission = permissions.length > 0 ? permissions[permissions.length - 1] : null;
  const latestApproval = approvals.length > 0 ? approvals[approvals.length - 1] : null;

  // Nothing to show
  if (!latestPermission && !latestApproval) {
    return null;
  }

  const totalCount = permissions.length + approvals.length;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 pointer-events-none">
      <div className="pointer-events-auto animate-slide-up">
        {/* Show approval banner if one is pending (approvals take priority) */}
        {latestApproval && (
          <ApprovalBanner
            approval={latestApproval}
            totalCount={totalCount}
            isExpanded={expandedId === latestApproval.requestId}
            onToggleExpand={() => setExpandedId(
              expandedId === latestApproval.requestId ? null : latestApproval.requestId
            )}
            onApprove={(response) => {
              approveApproval(latestApproval.requestId, response);
              setExpandedId(null);
            }}
            onDeny={() => {
              denyApproval(latestApproval.requestId);
              setExpandedId(null);
            }}
          />
        )}

        {/* Show permission banner if no approval is pending, or if there's also a permission */}
        {latestPermission && !latestApproval && (
          <PermissionBanner
            permission={latestPermission}
            totalCount={totalCount}
            isExpanded={expandedId === latestPermission.requestId}
            onToggleExpand={() => setExpandedId(
              expandedId === latestPermission.requestId ? null : latestPermission.requestId
            )}
            onAllow={() => {
              approvePermission(latestPermission.requestId);
              setExpandedId(null);
            }}
            onDeny={() => {
              denyPermission(latestPermission.requestId);
              setExpandedId(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function PermissionBanner({
  permission,
  totalCount,
  isExpanded,
  onToggleExpand,
  onAllow,
  onDeny,
}: {
  permission: PermissionRequest;
  totalCount: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const argsEntries = permission.args
    ? Object.entries(permission.args).filter(([, v]) => v != null && String(v).length > 0)
    : [];

  return (
    <div className="mx-4 mb-4 rounded-xl border border-yellow-800/40 bg-surface-container shadow-lg shadow-black/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3 min-w-0 flex-1 mr-3">
          <div className="shrink-0 w-8 h-8 rounded-lg bg-yellow-600/20 flex items-center justify-center">
            <Shield className="w-4 h-4 text-yellow-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-yellow-200">Permission Required</span>
              {totalCount > 1 && (
                <span className="text-xs text-on-surface-variant bg-surface-container-highest px-1.5 py-0.5 rounded-full">
                  +{totalCount - 1} more
                </span>
              )}
            </div>
            <p className="text-sm text-on-surface-variant truncate">
              <span className="font-mono font-medium">{permission.skillId}</span>
              {' \u00B7 '}
              <span className="font-mono">{permission.action}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {argsEntries.length > 0 && (
            <button
              onClick={onToggleExpand}
              className="flex items-center gap-1 px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface rounded-md hover:bg-surface-container-highest transition-colors cursor-pointer"
            >
              {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
              Details
            </button>
          )}
          <button
            onClick={onAllow}
            className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-green-600 text-on-surface rounded-lg hover:bg-green-700 transition-colors cursor-pointer"
          >
            <CheckCircle className="w-4 h-4" /> Allow
          </button>
          <button
            onClick={onDeny}
            className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-error text-on-surface rounded-lg hover:bg-error/80 transition-colors cursor-pointer"
          >
            <XCircle className="w-4 h-4" /> Deny
          </button>
        </div>
      </div>

      {/* Expandable details */}
      {isExpanded && argsEntries.length > 0 && (
        <div className="border-t border-outline-variant/10 px-4 py-3 bg-surface-container-low">
          <div className="space-y-1">
            {argsEntries.slice(0, 6).map(([key, value]) => (
              <div key={key} className="flex gap-2 text-xs">
                <span className="font-mono text-on-surface-variant shrink-0">{key}:</span>
                <span className="font-mono text-on-surface truncate">{String(value).slice(0, 200)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalBanner({
  approval,
  totalCount,
  isExpanded,
  onToggleExpand,
  onApprove,
  onDeny,
}: {
  approval: ApprovalRequest;
  totalCount: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onApprove: (response?: string) => void;
  onDeny: () => void;
}) {
  return (
    <div className="mx-4 mb-4 rounded-xl border border-orange-800/40 bg-surface-container shadow-lg shadow-black/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3 min-w-0 flex-1 mr-3">
          <div className="shrink-0 w-8 h-8 rounded-lg bg-orange-600/20 flex items-center justify-center">
            <Clock className="w-4 h-4 text-orange-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-orange-200">Approval Required</span>
              {totalCount > 1 && (
                <span className="text-xs text-on-surface-variant bg-surface-container-highest px-1.5 py-0.5 rounded-full">
                  +{totalCount - 1} more
                </span>
              )}
            </div>
            <p className="text-sm text-on-surface-variant truncate">{approval.summary}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {approval.question && (
            <button
              onClick={onToggleExpand}
              className="flex items-center gap-1 px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface rounded-md hover:bg-surface-container-highest transition-colors cursor-pointer"
            >
              {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
              Details
            </button>
          )}

          {approval.options?.length ? (
            <>
              {approval.options.map((option, i) => (
                <button
                  key={i}
                  onClick={() => onApprove(option)}
                  className="px-3 py-1.5 text-sm font-medium bg-surface-container-highest border border-outline-variant/10 rounded-lg hover:bg-surface-container-high text-on-surface transition-colors cursor-pointer"
                >
                  {option}
                </button>
              ))}
              <button
                onClick={onDeny}
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-error/20 border border-error/30 rounded-lg hover:bg-error/30 text-error transition-colors cursor-pointer"
              >
                <Square className="w-3 h-3" /> Stop
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => onApprove()}
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-green-600 text-on-surface rounded-lg hover:bg-green-700 transition-colors cursor-pointer"
              >
                <CheckCircle className="w-4 h-4" /> Approve
              </button>
              <button
                onClick={onDeny}
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-error text-on-surface rounded-lg hover:bg-error/80 transition-colors cursor-pointer"
              >
                <Square className="w-3 h-3" /> Stop
              </button>
            </>
          )}
        </div>
      </div>

      {/* Expandable details */}
      {isExpanded && approval.question && (
        <div className="border-t border-outline-variant/10 px-4 py-3 bg-surface-container-low">
          <p className="text-sm text-on-surface">{approval.question}</p>
        </div>
      )}
    </div>
  );
}
