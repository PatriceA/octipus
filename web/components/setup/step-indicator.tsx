'use client';

import { Check, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StepDefinition {
  id: string;
  label: string;
  icon: LucideIcon;
}

export interface StepIndicatorProps {
  steps: StepDefinition[];
  currentStep: number;
  onStepClick: (index: number) => void;
}

/**
 * Step indicator rendered as a TUI progress strip:
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
 *   └────────────────────────────────────────────────────────────┘
 *     [x] welcome  [x] llm  [▸] model  [ ] channels  [ ] account
 *
 * The single-line progress bar at the top is the bar; the row below
 * is a button strip with `[x]` / `[▸]` / `[ ]` glyphs.
 */
export function StepIndicator({ steps, currentStep, onStepClick }: StepIndicatorProps) {
  const pct = ((currentStep + 1) / steps.length) * 100;

  return (
    <div className="border-b border-outline-variant/60 bg-surface-container-low font-mono">
      <div className="h-1 bg-outline-variant/30">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[12px]">
        <span className="text-primary" aria-hidden>❯</span>
        <span className="text-on-surface-variant uppercase tracking-wider text-[10px]">setup</span>
        <span className="text-outline">|</span>
        {steps.map((step, i) => {
          const isDone = i < currentStep;
          const isActive = i === currentStep;
          return (
            <button
              key={step.id}
              onClick={() => onStepClick(i)}
              className={cn(
                'flex items-center gap-1.5 transition-colors',
                isActive
                  ? 'text-primary'
                  : isDone
                    ? 'text-tertiary hover:text-on-surface'
                    : 'text-outline-variant hover:text-on-surface-variant',
              )}
            >
              <span aria-hidden className="w-3 text-center">
                {isDone ? <Check className="w-3 h-3 inline" /> : isActive ? '▸' : '·'}
              </span>
              <step.icon className="w-3.5 h-3.5" aria-hidden />
              <span className="hidden sm:inline">{step.label.toLowerCase()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
