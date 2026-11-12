'use client';

import { memo } from 'react';
import { type CompanionAppearance, type CompanionState, DEFAULT_COMPANION_APPEARANCE, isCompanionAppearance } from '../../../src/shared/companion';
import { companionArtwork } from '../../../src/shared/companion-artwork';
import './companion-avatar.css';

export type { CompanionState };

/** Original Blender portraits; the host supplies status independently of the pose. */
export const CompanionAvatar = memo(function CompanionAvatar({
  state = 'idle', animated = false, size = 36, appearance,
}: { state?: CompanionState; animated?: boolean; size?: number; appearance?: CompanionAppearance; followPointer?: boolean }) {
  const look = isCompanionAppearance(appearance) ? appearance : DEFAULT_COMPANION_APPEARANCE;
  const moving = animated && (state === 'working' || state === 'listening');
  return <img src={companionArtwork(look)} width={size} height={size} alt="" aria-hidden="true"
    className={`octi-companion natural-companion${moving ? ' animated' : ''}`}
    data-state={state} data-form={look.form} data-color={look.color} data-motion={moving ? 'on' : 'off'}
    draggable={false} />;
});
