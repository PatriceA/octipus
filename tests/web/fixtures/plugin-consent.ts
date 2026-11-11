/**
 * Install-consent shapes for the plugin specs, built with the shared wording
 * (src/shared/plugin-declarations.ts), so the specs see the items, labels and
 * guidance the backend sends.
 */
import { consentItems, declarationItems, type PluginConsentItem, type PluginConsentView, type PluginInstallPreview } from '../../../src/shared/plugin-declarations';
import type { PluginManifest, PluginPermissionsSummary } from '../../../src/shared/plugin-package';

export const HASH = `sha256:${'c'.repeat(64)}`;
export const PREVIEW_ID = '44444444-4444-4444-8444-444444444444';

/** A permissions summary with everything empty but what `over` sets. */
export function perms(name: string, over: Partial<PluginPermissionsSummary> = {}): PluginPermissionsSummary {
  const tools = over.tools ?? [{ name: 'run', effect: 'read' as const }];
  return {
    name, version: '1.0.0', apiVersion: '1.0.0', runtime: 'package', host: [], network: [], secrets: [], settings: [], store: null, tools,
    effects: { read: tools.filter((t) => t.effect === 'read').length, write: tools.filter((t) => t.effect === 'write').length, external: tools.filter((t) => t.effect === 'external').length },
    contributions: { commands: [], schedules: [], events: [], prompt: null, context: null }, pages: [], ui: null, trustedInput: false, maxProtection: 1,
    ...over,
  };
}

/** The consent items of `p`, against the installed `before` (an upgrade) with what its consent covered. */
export function items(p: PluginPermissionsSummary, manifest?: Partial<PluginManifest> | null, before?: PluginPermissionsSummary, covered = true): PluginConsentItem[] {
  const m = (manifest ?? null) as PluginManifest | null;
  return consentItems(declarationItems(p, m), before ? declarationItems(before, m) : null, () => covered);
}

export function preview(p: PluginPermissionsSummary, over: Partial<PluginInstallPreview> = {}): PluginInstallPreview {
  return {
    previewId: PREVIEW_ID, name: p.name, version: p.version, title: p.name, contentHash: HASH, signedBy: 'Octipus',
    origin: { source: 'marketplace', registry: 'Octipus' }, declarations: items(p), guidance: [], diff: null, upgradeFrom: null,
    expiresAt: '2026-11-10T10:00:00Z', ...over,
  };
}

export function consentView(p: PluginPermissionsSummary, over: Partial<PluginConsentView> = {}): PluginConsentView {
  return {
    name: p.name, version: p.version, title: p.name, contentHash: HASH, signedBy: null, origin: { source: 'directory' }, enabled: false,
    declarations: items(p), guidance: [], ...over,
  };
}

/** Tick every consent item that is not carried. */
export async function tickAll(dialog: import('@playwright/test').Locator): Promise<void> {
  const boxes = dialog.locator('[data-testid="consent-item"][data-carried="false"] input[type="checkbox"]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).check();
}
