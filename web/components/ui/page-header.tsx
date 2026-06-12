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
 * Shared terminal-UI page header — the `octi:~/page $` path prompt with
 * a blinking caret (same idiom as the mobile app's TerminalTitle), plus
 * an optional badge and right-aligned actions, followed by a dim
 * description line. Used by app pages so heading style stays consistent
 * without each page re-implementing the prompt pattern.
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
        'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5 font-mono animate-enter',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold lowercase truncate">
            <span className="text-outline font-semibold">octi:</span>
            <span className="text-on-surface">~/{title}</span>
            <span className="text-primary font-bold"> $</span>
            <span aria-hidden className="term-caret" />
          </h1>
          {badge}
        </div>
        {description && (
          <p className="text-[12px] text-on-surface-variant max-w-prose mt-1">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
