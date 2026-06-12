'use client';

import { CheckCircle, Shield, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ApprovalCardProps {
  requestId: string;
  summary: string;
  question: string;
  options?: string[];
  onApprove: (requestId: string, response?: string) => void;
  onDeny: (requestId: string, response?: string) => void;
  className?: string;
}

export function ApprovalCard({
  requestId,
  summary,
  question,
  options,
  onApprove,
  onDeny,
  className,
}: ApprovalCardProps) {
  return (
    <div className={cn(
      'bg-warning-container/60 border border-warning/40 rounded-lg p-4',
      className
    )}>
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-warning-container/60 flex items-center justify-center shrink-0">
          <Shield className="w-4 h-4 text-warning" />
        </div>
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-warning mb-1">
            Approval Required
          </h4>
          {summary && (
            <p className="text-sm text-on-surface/80 mb-2">
              {summary}
            </p>
          )}
          <p className="text-sm font-medium text-on-surface mb-3">
            {question}
          </p>

          {options && options.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {options.map((option, i) => (
                <button
                  key={i}
                  onClick={() => onApprove(requestId, option)}
                  className="px-3 py-1.5 text-sm bg-surface-container border border-outline-variant/10 rounded-lg hover:bg-surface-container-high text-on-surface/80"
                >
                  {option}
                </button>
              ))}
              <button
                onClick={() => onDeny(requestId)}
                className="px-3 py-1.5 text-sm bg-error-container/60 border border-error/40 rounded-lg hover:bg-error-container/60 text-error"
              >
                Deny
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => onApprove(requestId)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-tertiary/50 bg-tertiary-container/60 text-tertiary rounded-xs hover:bg-tertiary-container"
              >
                <CheckCircle className="w-4 h-4" />
                Approve
              </button>
              <button
                onClick={() => onDeny(requestId)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-error/50 bg-error-container/60 text-error rounded-xs hover:bg-error-container"
              >
                <XCircle className="w-4 h-4" />
                Deny
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
