'use client';

import { CheckCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AssertionBadgeProps {
  type: string;
  passed: boolean;
  compact?: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  routes_to_role: 'Routing',
  uses_tool: 'Tool Use',
  not_uses_tool: 'No Tool',
  contains: 'Contains',
  not_contains: 'Not Contains',
  matches_regex: 'Regex',
  classification: 'Classification',
  confidence_above: 'Confidence',
  response_quality: 'Quality',
  latency_under: 'Latency',
  no_hallucination: 'No Hallucination',
  follows_format: 'Format',
  token_count_under: 'Token Count',
  defense_held: 'Defense Held',
};

export function AssertionBadge({ type, passed, compact }: AssertionBadgeProps) {
  const label = TYPE_LABELS[type] || type;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium',
        compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs',
        passed
          ? 'bg-tertiary-container/60 text-tertiary'
          : 'bg-error-container/60 text-error'
      )}
    >
      {passed ? (
        <CheckCircle className={cn(compact ? 'w-2.5 h-2.5' : 'w-3 h-3')} />
      ) : (
        <XCircle className={cn(compact ? 'w-2.5 h-2.5' : 'w-3 h-3')} />
      )}
      {label}
    </span>
  );
}
