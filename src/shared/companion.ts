export const COMPANION_FORMS = ['pebble', 'ribbon', 'ink'] as const;
export const COMPANION_COLORS = {
  'sea-glass': { label: 'Sea glass', hex: '#92c9c5' },
  coral: { label: 'Coral', hex: '#efa99b' },
  lavender: { label: 'Lavender', hex: '#b7a6e8' },
  sunshine: { label: 'Sunshine', hex: '#e9c776' },
  blue: { label: 'Ocean blue', hex: '#82b5df' },
} as const;

export interface CompanionAppearance {
  form: typeof COMPANION_FORMS[number];
  color: keyof typeof COMPANION_COLORS;
}

export const DEFAULT_COMPANION_APPEARANCE: CompanionAppearance = { form: 'pebble', color: 'sea-glass' };

export function isCompanionAppearance(value: unknown): value is CompanionAppearance {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return COMPANION_FORMS.some(form => form === v.form)
    && typeof v.color === 'string' && Object.hasOwn(COMPANION_COLORS, v.color);
}

/** Public display identity. Names are snapshots; the owner ID is the stable identity. */
export interface CompanionIdentity {
  appearance?: CompanionAppearance;
  ownerUserId: string;
  ownerName: string;
  name: string;
}

export function isCompanionIdentity(value: unknown): value is CompanionIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.ownerUserId === 'string' && typeof v.ownerName === 'string' && typeof v.name === 'string';
}

function mentionPattern(name: string): RegExp {
  const literal = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_@])@${literal}(?![\\p{L}\\p{N}_@-])`, 'giu');
}

/** Literal names, including spaces and Unicode; never an email or remote handle. */
export function mentionsCompanion(content: string, name: string): boolean {
  return !!name.trim() && mentionPattern(name).test(content);
}

export function withoutCompanionMentions(content: string, name: string): string {
  return name.trim() ? content.replace(mentionPattern(name), '$1') : content;
}
