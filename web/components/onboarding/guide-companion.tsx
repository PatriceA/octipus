'use client';

import { CompanionAvatar, type CompanionState } from '@/components/companion/companion-avatar';
import type { CompanionAppearance } from '../../../src/shared/companion';

/**
 * The companion hosting the setup guide: the person's own companion (its
 * name and look from the persona), saying one line at a time in a speech
 * bubble and showing how things go — listening while you answer, working
 * while it sets things up, waiting when it needs you, cheering when
 * something is added. The avatar's CSS already honours reduced motion.
 */
export function GuideCompanion({ state, line, name, appearance, heading }: {
  state: CompanionState;
  line: string;
  name: string;
  appearance?: CompanionAppearance;
  heading: string;
}) {
  return (
    <div className="flex items-start gap-3 sm:gap-4 min-w-0">
      <div className="self-start rounded-2xl bg-companion-paper p-1.5 sm:p-2 shrink-0" data-testid="guide-companion" data-state={state}>
        <span className="sm:hidden"><CompanionAvatar size={56} state={state} animated appearance={appearance} /></span>
        <span className="hidden sm:block"><CompanionAvatar size={84} state={state} animated appearance={appearance} followPointer={state === 'idle'} /></span>
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-xs text-primary">{name} · your companion</p>
        <h2 className="text-lg font-semibold leading-snug">{heading}</h2>
        <p
          role="status"
          aria-live="polite"
          data-testid="guide-line"
          className="mt-2 inline-block max-w-prose rounded-2xl rounded-tl-md border border-outline-variant/30 bg-surface-container px-3.5 py-2 text-sm text-on-surface shadow-xs"
        >
          {line}
        </p>
      </div>
    </div>
  );
}
