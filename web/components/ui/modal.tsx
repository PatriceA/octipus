'use client';

import { X } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  title?: string;
  maxWidth?: 'sm' | 'md' | 'lg';
}

const maxWidthMap = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

/**
 * Terminal-UI modal — backdrop, framed surface, `▸ title` titlebar.
 * Square corners, single-line dim border, JetBrains Mono throughout.
 */
export function Modal({ open, onClose, children, className, title, maxWidth = 'md' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center font-mono">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        className={cn(
          'relative w-full mx-4 bg-surface-container border border-outline-variant rounded-xs shadow-2xl',
          'animate-in fade-in zoom-in-95 duration-150',
          maxWidthMap[maxWidth],
          className,
        )}
      >
        {title && (
          <div className="flex items-center justify-between px-3 py-2 border-b border-outline-variant/60 bg-surface-container-low">
            <h3 className="text-[13px] text-on-surface flex items-center gap-1.5">
              <span aria-hidden className="text-outline-variant">▸</span>
              {title.toLowerCase()}
            </h3>
            <button
              onClick={onClose}
              className="p-1 text-outline-variant hover:text-on-surface rounded-xs hover:bg-surface-container-high cursor-pointer transition-colors"
              aria-label="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
