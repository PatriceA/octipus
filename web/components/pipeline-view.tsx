'use client';

import { CheckCircle, Loader2, Clock, XCircle, SkipForward, Shield, Circle } from 'lucide-react';
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
  pending: { icon: Clock, color: 'text-gray-500', bgColor: 'bg-gray-100 dark:bg-gray-700', ringColor: 'ring-gray-300' },
  running: { icon: Loader2, color: 'text-blue-500', bgColor: 'bg-blue-100 dark:bg-blue-900/30', ringColor: 'ring-blue-400' },
  awaiting_approval: { icon: Shield, color: 'text-orange-500', bgColor: 'bg-orange-100 dark:bg-orange-900/30', ringColor: 'ring-orange-400' },
  approved: { icon: CheckCircle, color: 'text-green-500', bgColor: 'bg-green-100 dark:bg-green-900/30', ringColor: 'ring-green-400' },
  completed: { icon: CheckCircle, color: 'text-green-600', bgColor: 'bg-green-100 dark:bg-green-900/30', ringColor: 'ring-green-500' },
  failed: { icon: XCircle, color: 'text-red-500', bgColor: 'bg-red-100 dark:bg-red-900/30', ringColor: 'ring-red-400' },
  skipped: { icon: SkipForward, color: 'text-gray-500', bgColor: 'bg-gray-50 dark:bg-gray-800', ringColor: 'ring-gray-300' },
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
                  'w-10 h-10 rounded-full flex items-center justify-center ring-2',
                  config.bgColor,
                  config.ringColor,
                  isActive && 'ring-4'
                )}
              >
                <Icon className={cn('w-5 h-5', config.color, isActive && 'animate-spin')} />
              </div>
              <span className={cn(
                'mt-1 text-xs font-medium whitespace-nowrap',
                isActive ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'
              )}>
                {stage.name}
              </span>
              <span className="text-[10px] text-gray-500">{stage.role}</span>
              {stage.status === 'awaiting_approval' && onApprove && (
                <button
                  onClick={() => onApprove(stage.id)}
                  className="mt-1 px-2 py-0.5 text-xs bg-orange-500 text-white rounded-full hover:bg-orange-600"
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
                  ? 'bg-green-400'
                  : 'bg-gray-300 dark:bg-gray-600'
              )} />
            )}
          </div>
        );
      })}
    </div>
  );
}
