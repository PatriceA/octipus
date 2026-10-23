import { isModuleOn } from '@/core/modules/registry';
import { effectiveProtectionLevel } from '@/shared/protection';

/**
 * A protection level as agents see it: the effective level (null: unclear,
 * 4) while the `protection` module is on, undefined while it is off, so the
 * field drops out of a tool result (docs/MODULES.md).
 */
export function visibleProtectionLevel(level: number | null | undefined): number | undefined {
  return isModuleOn('protection') ? effectiveProtectionLevel(level ?? null) : undefined;
}
