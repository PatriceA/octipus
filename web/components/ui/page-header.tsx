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
 * Shared terminal-UI page header — the `❯ pagename` prompt + an
 * optional badge + optional right-aligned actions, followed by a dim
 * description line. Used by most app pages so heading style stays
 * consistent without each page re-implementing the chevron pattern.
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
        'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5 font-mono',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-primary text-base font-bold">
            ❯
          </span>
          <h1 className="text-lg text-on-surface lowercase">{title}</h1>
          {badge}
        </div>
        {description && (
          <p className="text-[12px] text-on-surface-variant max-w-prose mt-1 pl-5">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
