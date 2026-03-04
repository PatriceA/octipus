'use client';

import { CheckCircle, type LucideIcon } from 'lucide-react';

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

export function StepIndicator({ steps, currentStep, onStepClick }: StepIndicatorProps) {
  return (
    <>
      {/* Progress bar */}
      <div className="w-full bg-gray-200 dark:bg-gray-800 h-1">
        <div
          className="bg-primary-600 h-1 transition-all duration-300"
          style={{ width: `${((currentStep + 1) / steps.length) * 100}%` }}
        />
      </div>

      {/* Step indicators */}
      <div className="flex justify-center gap-4 py-6">
        {steps.map((step, i) => (
          <button
            key={step.id}
            onClick={() => onStepClick(i)}
            className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
              i <= currentStep
                ? 'text-primary-600 dark:text-primary-400'
                : 'text-gray-400 dark:text-gray-600'
            }`}
          >
            {i < currentStep ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <step.icon className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">{step.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
