import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export type StatusVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'primary';

interface StatusBadgeProps {
  children: ReactNode;
  variant?: StatusVariant;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}

const variantStyles: Record<StatusVariant, { wrap: string; dot: string }> = {
  success: {
    wrap: 'bg-primary/10 border-primary/20 text-primary',
    dot: 'bg-primary shadow-[0_0_8px_rgba(115,255,227,0.6)]',
  },
  primary: {
    wrap: 'bg-primary/10 border-primary/20 text-primary',
    dot: 'bg-primary shadow-[0_0_8px_rgba(115,255,227,0.6)]',
  },
  info: {
    wrap: 'bg-tertiary/10 border-tertiary/20 text-tertiary',
    dot: 'bg-tertiary shadow-[0_0_8px_rgba(156,243,255,0.6)]',
  },
  warning: {
    wrap: 'bg-amber-500/10 border-amber-500/20 text-amber-300',
    dot: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]',
  },
  danger: {
    wrap: 'bg-error/10 border-error/20 text-error',
    dot: 'bg-error shadow-[0_0_8px_rgba(255,113,108,0.6)]',
  },
  neutral: {
    wrap: 'bg-surface-container-highest border-outline-variant/20 text-on-surface-variant',
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
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 border rounded-full text-[10px] font-bold uppercase tracking-widest',
        v.wrap,
        className,
      )}
    >
      {dot && (
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full shrink-0',
            v.dot,
            pulse && 'animate-pulse',
          )}
        />
      )}
      {children}
    </span>
  );
}
