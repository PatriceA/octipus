'use client';

import { CheckCircle, Clock, Loader2, Shield, SkipForward, XCircle, } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PipelineNode {
  id: string;
  nodeKey: string;
  name: string;
  role: string;
  status: 'pending' | 'running' | 'awaiting_approval' | 'approved' | 'completed' | 'failed' | 'skipped';
  kind?: 'step' | 'foreach' | 'human';
  ordinal: number;
  /** Set on a loop-body node — the `foreach` head it belongs to. */
  parentNodeKey?: string | null;
}

interface PlanItem {
  id: string;
  ordinal: number;
  title: string;
  detail?: string | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
}

interface PipelineViewProps {
  nodes: PipelineNode[];
  /** The node the walker is on. A graph has no single ordinal position. */
  currentNodeKey?: string | null;
  /** The live plan, when the pipeline has a `foreach` node. */
  plan?: PlanItem[];
  onApprove?: (nodeId: string) => void;
  className?: string;
}

const PLAN_STATUS_DOT: Record<PlanItem['status'], string> = {
  pending: 'bg-outline-variant',
  running: 'bg-primary animate-pulse',
  done: 'bg-tertiary',
  failed: 'bg-error',
  skipped: 'bg-surface-container-high',
};

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

export function PipelineView({ nodes, currentNodeKey, plan, onApprove, className }: PipelineViewProps) {
  const stages = nodes;
  const done = plan?.filter((p) => p.status === 'done' || p.status === 'skipped').length ?? 0;

  return (
    <div className={cn('py-2', className)}>
    <div className="flex items-center gap-1 overflow-x-auto">
      {stages.map((stage, i) => {
        const config = STATUS_CONFIG[stage.status] || STATUS_CONFIG.pending;
        const Icon = config.icon;
        // The walker's position, not "the highest completed index" — a backward
        // edge or a loop body revisits nodes, so status alone cannot say where
        // the run actually is.
        const isActive = stage.status === 'running' || stage.nodeKey === currentNodeKey;

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
              <span className="text-[10px] text-on-surface-variant">
                {stage.kind === 'foreach' && plan
                  ? `${done}/${plan.length} items`
                  : stage.kind === 'human'
                    ? 'you'
                    : stage.role}
              </span>
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

    {/* The live plan. Editable through /api/pipelines/:id/plan while the
        pipeline runs — the loop re-reads it on every pass. */}
    {plan && plan.length > 0 && (
      <ul className="mt-3 space-y-1">
        {plan.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-xs">
            <span className={cn('mt-1 w-1.5 h-1.5 rounded-full shrink-0', PLAN_STATUS_DOT[item.status])} />
            <span className={cn(
              item.status === 'done' && 'text-on-surface-variant line-through',
              item.status === 'skipped' && 'text-on-surface-variant line-through opacity-60',
              item.status === 'running' && 'text-primary',
            )}>
              {item.title}
              {item.detail && <span className="text-on-surface-variant"> — {item.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    )}
    </div>
  );
}
