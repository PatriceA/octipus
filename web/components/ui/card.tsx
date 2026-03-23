import { cn } from '@/lib/utils';
import { type ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}

export function Card({ children, className, hover }: CardProps) {
  return (
    <div
      className={cn(
        'bg-surface-container rounded-[1rem] ring-1 ring-outline-variant/10',
        hover && 'hover:bg-surface-container-high hover:ring-outline-variant/20 transition-all cursor-pointer',
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: Omit<CardProps, 'hover'>) {
  return (
    <div
      className={cn(
        'px-6 py-5 border-b border-outline-variant/10',
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: Omit<CardProps, 'hover'>) {
  return (
    <h3
      className={cn(
        'text-sm font-extrabold tracking-tighter text-white',
        className
      )}
    >
      {children}
    </h3>
  );
}

export function CardContent({ children, className }: Omit<CardProps, 'hover'>) {
  return <div className={cn('p-6', className)}>{children}</div>;
}
