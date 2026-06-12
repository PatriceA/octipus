'use client';

import { CheckCircle, Clock, Loader2, Shield, SkipForward, XCircle, } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PipelineStage {
  id: string;
  name: string;
  role: string;
  status: 'pending' | 'running' | 'awaiting_approval' | 'approved' | 'completed' | 'failed' | 'skipped';
  stageIndex: number;
}

interface PipelineViewProps {
  stages: PipelineStage[];
  currentStageIndex: number;
  onApprove?: (stageId: string) => void;
  className?: string;
}

const STATUS_CONFIG: Record<string, {
  icon: typeof CheckCircle;
  color: string;
  bgColor: string;
  ringColor: string;
}> = {
  pending: { icon: Clock, color: 'text-on-surface-variant', bgColor: 'bg-surface-container-high', ringColor: 'ring-outline-variant' },
  running: { icon: Loader2, color: 'text-primary', bgColor: 'bg-primary/10', ringColor: 'ring-primary' },
  awaiting_approval: { icon: Shield, color: 'text-warning', bgColor: 'bg-warning-container/40', ringColor: 'ring-warning' },
  approved: { icon: CheckCircle, color: 'text-tertiary', bgColor: 'bg-tertiary/10', ringColor: 'ring-tertiary' },
  completed: { icon: CheckCircle, color: 'text-tertiary', bgColor: 'bg-tertiary/10', ringColor: 'ring-tertiary' },
  failed: { icon: XCircle, color: 'text-error', bgColor: 'bg-error/10', ringColor: 'ring-error' },
  skipped: { icon: SkipForward, color: 'text-on-surface-variant', bgColor: 'bg-surface-container', ringColor: 'ring-outline-variant' },
};

export function PipelineView({ stages, currentStageIndex, onApprove, className }: PipelineViewProps) {
  return (
    <div className={cn('flex items-center gap-1 overflow-x-auto py-2', className)}>
      {stages.map((stage, i) => {
        const config = STATUS_CONFIG[stage.status] || STATUS_CONFIG.pending;
        const Icon = config.icon;
        const isActive = stage.status === 'running';

        return (
          <div key={stage.id} className="flex items-center">
            {/* Stage node */}
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  'rounded-full',
                  isActive && 'glow-accent',
                  stage.status === 'awaiting_approval' && 'glow-warn',
                )}
              >
              <div
                className={cn(
                  'w-10 h-10 rounded-full flex items-center justify-center ring-2',
                  config.bgColor,
                  config.ringColor,
                  isActive && 'ring-4'
                )}
              >
                <Icon className={cn('w-5 h-5', config.color, isActive && 'animate-spin')} />
              </div>
              </div>
              <span className={cn(
                'mt-1 text-xs font-medium whitespace-nowrap',
                isActive ? 'text-primary' : 'text-on-surface-variant'
              )}>
                {stage.name}
              </span>
              <span className="text-[10px] text-on-surface-variant">{stage.role}</span>
              {stage.status === 'awaiting_approval' && onApprove && (
                <button
                  onClick={() => onApprove(stage.id)}
                  className="mt-1 px-2 py-0.5 text-xs bg-warning text-on-warning rounded-full hover:bg-warning-dim glow-warn"
                >
                  Approve
                </button>
              )}
            </div>

            {/* Connector line */}
            {i < stages.length - 1 && (
              <div className={cn(
                'w-8 h-0.5 mx-1',
                stages[i + 1]?.status !== 'pending'
                  ? 'bg-tertiary'
                  : 'bg-outline-variant'
              )} />
            )}
          </div>
        );
      })}
    </div>
  );
}
