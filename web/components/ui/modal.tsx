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
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-md"
        onClick={onClose}
      />
      <div
        className={cn(
          'relative w-full mx-4 bg-surface-variant/80 backdrop-blur-[20px] rounded-[1rem] shadow-[0_20px_60px_-15px_rgba(115,255,227,0.1)] border border-outline-variant/20',
          'animate-in fade-in zoom-in-95 duration-200',
          maxWidthMap[maxWidth],
          className
        )}
      >
        {title && (
          <div className="flex items-center justify-between px-6 py-5 border-b border-outline-variant/10">
            <h3 className="text-lg font-extrabold tracking-tighter text-white">{title}</h3>
            <button
              onClick={onClose}
              className="p-1.5 text-on-surface-variant hover:text-white rounded-full hover:bg-surface-container-high cursor-pointer transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
