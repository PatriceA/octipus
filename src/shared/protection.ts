/**
 * Protection levels (docs/PROTECTION-LEVELS.md): how sensitive a piece of
 * content is, which decides where it may be processed. Dependency-free.
 *
 * 1 public · 2 internal · 3 confidential (personal data) · 4 strictly
 * confidential (special categories: health, KIM, HR, legal). Content
 * without a level is unclear and counts as 4.
 */
export const PROTECTION_LEVELS = [1, 2, 3, 4] as const;
export type ProtectionLevel = (typeof PROTECTION_LEVELS)[number];

/** What unclear content counts as. */
export const UNCLEAR_PROTECTION_LEVEL: ProtectionLevel = 4;

export const PROTECTION_LEVEL_LABELS: Readonly<Record<ProtectionLevel, string>> = {
  1: 'Public',
  2: 'Internal',
  3: 'Confidential',
  4: 'Strictly confidential',
};

export function isProtectionLevel(value: unknown): value is ProtectionLevel {
  return typeof value === 'number' && (PROTECTION_LEVELS as readonly number[]).includes(value);
}

/** The level content is treated at: its own, else the one it inherited, else unclear (4). */
export function effectiveProtectionLevel(own: number | null | undefined, inherited?: number | null): ProtectionLevel {
  if (isProtectionLevel(own)) return own;
  if (isProtectionLevel(inherited)) return inherited;
  return UNCLEAR_PROTECTION_LEVEL;
}
