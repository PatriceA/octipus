import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type CardVariant = 'default' | 'glass' | 'bento';

interface CardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  variant?: CardVariant;
}

const variantClasses: Record<CardVariant, string> = {
  default: 'bg-surface-container rounded-[1rem] ring-1 ring-outline-variant/10',
  glass:
    'bg-surface-variant/60 backdrop-blur-[20px] rounded-[1rem] border border-outline-variant/10',
  bento:
    'bg-surface-variant/60 backdrop-blur-[20px] rounded-2xl border border-outline-variant/10 shadow-[0_0_30px_-12px_rgba(115,255,227,0.12)]',
};

const hoverClasses: Record<CardVariant, string> = {
  default:
    'hover:bg-surface-container-high hover:ring-outline-variant/20 transition-all cursor-pointer',
  glass:
    'hover:bg-surface-variant/80 hover:border-outline-variant/20 transition-all cursor-pointer',
  bento:
    'hover:border-primary/30 hover:shadow-[0_0_40px_-10px_rgba(115,255,227,0.25)] hover:-translate-y-0.5 transition-all duration-300 cursor-pointer',
};

export function Card({ children, className, hover, variant = 'default' }: CardProps) {
  return (
    <div className={cn(variantClasses[variant], hover && hoverClasses[variant], className)}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: Omit<CardProps, 'hover' | 'variant'>) {
  return (
    <div className={cn('px-6 py-5 border-b border-outline-variant/10', className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: Omit<CardProps, 'hover' | 'variant'>) {
  return (
    <h3 className={cn('text-sm font-extrabold tracking-tighter text-white', className)}>
      {children}
    </h3>
  );
}

export function CardContent({ children, className }: Omit<CardProps, 'hover' | 'variant'>) {
  return <div className={cn('p-6', className)}>{children}</div>;
}
