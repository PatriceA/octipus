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
      'bg-orange-900/20 border border-orange-800 rounded-lg p-4',
      className
    )}>
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-orange-900/50 flex items-center justify-center shrink-0">
          <Shield className="w-4 h-4 text-orange-400" />
        </div>
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-orange-200 mb-1">
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
                className="px-3 py-1.5 text-sm bg-red-900/20 border border-red-800 rounded-lg hover:bg-red-900/30 text-red-400"
              >
                Deny
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => onApprove(requestId)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-green-600 text-on-surface rounded-lg hover:bg-green-700"
              >
                <CheckCircle className="w-4 h-4" />
                Approve
              </button>
              <button
                onClick={() => onDeny(requestId)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-600 text-on-surface rounded-lg hover:bg-red-700"
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
