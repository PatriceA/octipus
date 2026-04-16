import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * Shared page header — compact "admin-panel" style to keep the whole app
 * visually coherent with the Intelligent Void design.
 *
 * Title:       font-headline text-2xl font-extrabold tracking-tighter
 * Description: text-on-surface-variant, max-w-prose
 * Badge slot:  typically a <StatusBadge/> next to the title
 * Actions:     primary/secondary buttons right-aligned
 */
export function PageHeader({
  title,
  description,
  badge,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="font-headline text-2xl font-extrabold tracking-tighter text-white">
            {title}
          </h1>
          {badge}
        </div>
        {description && (
          <p className="text-sm text-on-surface-variant max-w-prose">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
