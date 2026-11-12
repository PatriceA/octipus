import { type CompanionAppearance, DEFAULT_COMPANION_APPEARANCE, isCompanionAppearance } from './companion';

/** Stable form IDs preserve saved account choices across clients. */
export const COMPANION_LOOK_NAMES = { pebble: 'Dumbo', ribbon: 'Reef', ink: 'Inky' } as const;

export function companionArtwork(appearance?: CompanionAppearance): string {
  const look = isCompanionAppearance(appearance) ? appearance : DEFAULT_COMPANION_APPEARANCE;
  return `/companions/${look.form}-${look.color}.webp`;
}
