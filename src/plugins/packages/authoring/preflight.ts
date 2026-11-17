import { z } from 'zod';
import { PLUGIN_HOST_SCOPES, PLUGIN_PACKAGE_API_VERSION } from '@/shared/plugin-package';
import { effectiveMaxProtection } from '../service';

const request = z.object({ protectionLevel: z.number().int().min(1).max(4), interface: z.enum(['page', 'dashboard', 'tools']), host: z.array(z.enum(PLUGIN_HOST_SCOPES)).max(30).default([]) }).strict();

/** Capability planning before code is generated; never guesses a lower classification. */
export function pluginCapabilityPreflight(input: unknown) {
  const needs = request.parse(input);
  const cap = effectiveMaxProtection({ maxProtection: 4, host: needs.host, ...(needs.interface === 'page' ? { ui: { pages: [{ path: 'main', title: 'Main', entry: 'index.html' }] } } : {}) }, needs.host);
  return { compatible: needs.protectionLevel <= cap, requestedProtection: needs.protectionLevel, supportedProtection: cap, apiVersion: PLUGIN_PACKAGE_API_VERSION,
    message: needs.protectionLevel <= cap ? 'This capability combination is supported. Use guided setup, existing connections and a vendored host client.' : 'This combination cannot handle the requested classification. Do not generate it and discover that after installation. Keep the classification; choose a compatible interface/capability combination.',
    signing: 'Local private use needs no publisher key. Marketplace installation uses the marketplace signature. Only marketplace publishers sign releases.' };
}
