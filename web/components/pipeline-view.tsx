'use client';

import { CheckCircle, Clock, Loader2, Repeat, Shield, SkipForward, XCircle, } from 'lucide-react';
import { Fragment } from 'react';
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
  /** Why the item did not run (e.g. the loop's item limit). */
  error?: string | null;
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
  const done = plan?.filter((p) => p.status === 'done').length ?? 0;
  const skipped = plan?.filter((p) => p.status === 'skipped').length ?? 0;
  const runningItem = plan?.find((p) => p.status === 'running');
  // Top level in walk order; a loop's body nodes are drawn inside its frame.
  const topLevel = nodes.filter((n) => !n.parentNodeKey);
  const bodyOf = (key: string) => nodes.filter((n) => n.parentNodeKey === key);

  const renderNode = (stage: PipelineNode) => {
    const config = STATUS_CONFIG[stage.status] || STATUS_CONFIG.pending;
    const Icon = config.icon;
    // The walker's position, not "the highest completed index" — a backward
    // edge or a loop body revisits nodes, so status alone cannot say where
    // the run actually is.
    const isActive = stage.status === 'running' || stage.nodeKey === currentNodeKey;
    return (
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
            {stage.kind === 'foreach' ? 'Approve plan' : 'Approve'}
          </button>
        )}
      </div>
    );
  };

  const connector = (next: PipelineNode | undefined) => (
    <div className={cn(
      'w-8 h-0.5 mx-1 shrink-0',
      next && next.status !== 'pending' ? 'bg-tertiary' : 'bg-outline-variant'
    )} />
  );

  return (
    <div className={cn('py-2', className)}>
    <div className="flex items-center gap-1 overflow-x-auto px-4 py-4">
      {topLevel.map((stage, i) => {
        const next = topLevel[i + 1];
        if (stage.kind !== 'foreach') {
          return (
            <Fragment key={stage.id}>
              {renderNode(stage)}
              {next && connector(next)}
            </Fragment>
          );
        }
        // The plan loop: its head, then the steps that repeat, framed together
        // so it is visible which stages run once per item.
        const body = bodyOf(stage.nodeKey);
        return (
          <Fragment key={stage.id}>
            <div
              className="flex flex-col rounded-xl border border-dashed border-primary/40 px-3 pt-1.5 pb-2"
              aria-label="Plan loop — these stages repeat for each plan item"
            >
              <div className="flex items-center gap-1 text-[10px] text-primary whitespace-nowrap mb-1">
                <Repeat className="w-3 h-3" />
                <span>
                  Repeats for each plan item
                  {plan?.length ? ` · ${done}/${plan.length} done` : ''}
                  {skipped ? ` · ${skipped} skipped` : ''}
                  {runningItem ? ` · now: ${runningItem.title}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {renderNode(stage)}
                {body.map((b, j) => (
                  <Fragment key={b.id}>
                    {connector(b)}
                    {renderNode(b)}
                    {j === body.length - 1 && <Repeat className="w-3.5 h-3.5 ml-1 text-primary shrink-0" aria-label="back to the next plan item" />}
                  </Fragment>
                ))}
              </div>
            </div>
            {next && connector(next)}
          </Fragment>
        );
      })}
    </div>

    {/* The live plan. Editable through /api/pipelines/:id/plan while the
        pipeline runs — the loop re-reads it on every pass. */}
    {plan && plan.length > 0 && (
      <div className="mt-3">
        <div className="text-[11px] text-on-surface-variant mb-1">
          Plan — {done} of {plan.length} done{skipped ? `, ${skipped} skipped` : ''}
        </div>
        <ul className="space-y-1">
          {plan.map((item) => (
            <li key={item.id} className="flex items-start gap-2 text-xs" title={item.error ?? undefined}>
              <span className={cn('mt-1 w-1.5 h-1.5 rounded-full shrink-0', PLAN_STATUS_DOT[item.status])} />
              <span className={cn(
                item.status === 'done' && 'text-on-surface-variant line-through',
                item.status === 'skipped' && 'text-on-surface-variant line-through opacity-60',
                item.status === 'running' && 'text-primary',
              )}>
                {item.title}
                {item.detail && <span className="text-on-surface-variant"> — {item.detail}</span>}
              </span>
              {item.status === 'skipped' && item.error && (
                <span className="text-[10px] text-on-surface-variant">({item.error})</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    )}
    </div>
  );
}
