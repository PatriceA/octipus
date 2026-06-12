import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type CardVariant = 'default' | 'glass' | 'bento';
type CardGlow = 'primary' | 'ok' | 'warn' | 'err' | 'pink';

interface CardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  variant?: CardVariant;
  /** Soft outer glow — reserve for live things (running jobs, pending approvals). */
  glow?: CardGlow;
}

/**
 * Terminal-UI card primitive — every variant resolves to a flat
 * surface with a single-line dim border. The three names are kept
 * for backwards compatibility; the visual difference between them
 * is now subtle (surface tint) instead of dramatic (glass blur /
 * bento gradient). Pages that need a denser panel use `glass`;
 * pages that want emphasis use `bento`.
 */
const variantClasses: Record<CardVariant, string> = {
  default: 'bg-surface-container border border-outline-variant/60 rounded-xs',
  glass: 'bg-surface-container-low/80 backdrop-blur-sm border border-outline-variant/60 rounded-xs',
  bento: 'bg-surface-container border border-outline-variant rounded-xs',
};

const hoverClasses: Record<CardVariant, string> = {
  default: 'hover:border-outline hover:bg-surface-container-high transition-colors cursor-pointer',
  glass: 'hover:border-outline hover:bg-surface-container transition-colors cursor-pointer',
  bento: 'hover:border-primary hover:bg-surface-container-high transition-colors cursor-pointer',
};

const glowClasses: Record<CardGlow, string> = {
  primary: 'glow-accent border-primary/40',
  ok: 'glow-ok border-tertiary/40',
  warn: 'glow-warn border-warning/40',
  err: 'glow-err border-error/40',
  pink: 'glow-pink border-accent/40',
};

export function Card({ children, className, hover, variant = 'default', glow }: CardProps) {
  return (
    <div
      className={cn(
        variantClasses[variant],
        hover && hoverClasses[variant],
        glow && glowClasses[glow],
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: Omit<CardProps, 'hover' | 'variant'>) {
  return (
    <div
      className={cn(
        'px-4 py-2.5 border-b border-outline-variant/60 bg-surface-container-low/60 flex items-center gap-2',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: Omit<CardProps, 'hover' | 'variant'>) {
  return (
    <h3
      className={cn(
        'text-[13px] text-on-surface font-mono flex items-center gap-1.5',
        className,
      )}
    >
      <span aria-hidden className="text-primary font-bold">
        &gt;
      </span>
      {children}
    </h3>
  );
}

export function CardContent({ children, className }: Omit<CardProps, 'hover' | 'variant'>) {
  return <div className={cn('p-4', className)}>{children}</div>;
}
