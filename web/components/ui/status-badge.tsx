import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type StatusVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'primary';

interface StatusBadgeProps {
  children: ReactNode;
  variant?: StatusVariant;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}

/**
 * Terminal-UI status badge — `[ ● label ]` style.
 *
 * Square frame, monospace, single-line border in the variant colour.
 * The dot uses the same colour as the text so the badge reads like a
 * single coloured token rather than a Material-style pill. Pulse is
 * retained for the "live" case (e.g. "3 live agents").
 */
const variantStyles: Record<StatusVariant, { wrap: string; dot: string }> = {
  success: {
    wrap: 'border-tertiary/60 text-tertiary bg-tertiary-container/40',
    dot: 'bg-tertiary',
  },
  primary: {
    wrap: 'border-primary/60 text-primary bg-primary-container/40',
    dot: 'bg-primary',
  },
  info: {
    wrap: 'border-primary/60 text-primary bg-primary-container/30',
    dot: 'bg-primary',
  },
  warning: {
    wrap: 'border-warning/60 text-warning bg-warning-container/40',
    dot: 'bg-warning',
  },
  danger: {
    wrap: 'border-error/60 text-error bg-error-container/40',
    dot: 'bg-error',
  },
  neutral: {
    wrap: 'border-outline-variant text-on-surface-variant bg-surface-container-high',
    dot: 'bg-on-surface-variant',
  },
};

export function StatusBadge({
  children,
  variant = 'neutral',
  dot = false,
  pulse = false,
  className,
}: StatusBadgeProps) {
  const v = variantStyles[variant];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-1.5 py-0.5 border rounded-xs text-[10px] uppercase tracking-wider font-mono leading-none',
        v.wrap,
        className,
      )}
    >
      {dot && (
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full shrink-0',
            v.dot,
            pulse && 'dot-live',
          )}
        />
      )}
      {children}
    </span>
  );
}
