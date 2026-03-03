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
        'bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60',
        hover && 'hover:shadow-md hover:ring-primary-200/60 dark:hover:ring-primary-800/60 transition-all cursor-pointer',
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
        'px-5 py-4 border-b border-gray-100 dark:border-gray-700/60',
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
        'text-lg font-semibold text-gray-900 dark:text-gray-100',
        className
      )}
    >
      {children}
    </h3>
  );
}

export function CardContent({ children, className }: Omit<CardProps, 'hover'>) {
  return <div className={cn('p-5', className)}>{children}</div>;
}
