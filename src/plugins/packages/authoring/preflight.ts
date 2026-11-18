import { z } from 'zod';
import { PLUGIN_HOST_SCOPES, PLUGIN_PACKAGE_API_VERSION } from '@/shared/plugin-package';
import { configurableProtectionMaximum } from '../protection-policy';
import { effectiveMaxProtection } from '../service';

const request = z.object({ protectionLevel: z.number().int().min(1).max(4), interface: z.enum(['page', 'dashboard', 'tools', 'protected']), host: z.array(z.enum(PLUGIN_HOST_SCOPES)).max(30).default([]) }).strict();

/** Capability planning before code is generated; never guesses a lower classification. */
export function pluginCapabilityPreflight(input: unknown) {
  const needs = request.parse(input);
  const cap = needs.interface==='protected'||needs.interface==='tools' ? configurableProtectionMaximum({name:'preflight',title:'Preflight',description:'Capability check',version:'1.0.0',apiVersion:PLUGIN_PACKAGE_API_VERSION,host:needs.host},needs.host) : effectiveMaxProtection({ maxProtection: 4, host: needs.host, ...(needs.interface === 'page' ? { ui: { pages: [{ path: 'main', title: 'Main', entry: 'index.html' }] } } : {}) }, needs.host);
  return { requiresOwnerApproval:needs.protectionLevel>1 && needs.host.some(s=>s==='repos:collect'||s==='connections:read'), protectedAlternative: { supportedProtection:configurableProtectionMaximum({name:'preflight',title:'Preflight',description:'Capability check',version:'1.0.0',apiVersion:PLUGIN_PACKAGE_API_VERSION,host:needs.host},needs.host), settings:'Administration → Plugin packages → Data access' }, compatible: needs.protectionLevel <= cap, requestedProtection: needs.protectionLevel, supportedProtection: cap, apiVersion: PLUGIN_PACKAGE_API_VERSION,
    message: needs.protectionLevel <= cap ? 'This capability combination is supported. Owner data approval and selected trusted destinations are required for protected data; capability support does not grant access.' : 'This combination cannot handle the requested classification. Do not generate it and discover that after installation. Keep the classification; use the protected view or chat with owner-approved Data access where its supported maximum allows it.',
    signing: 'Local private use needs no publisher key. Marketplace installation uses the marketplace signature. Only marketplace publishers sign releases.' };
}
