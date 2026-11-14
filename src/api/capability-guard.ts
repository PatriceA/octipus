import { isCapabilityOn } from '@/core/capabilities/gates';
import { CAPABILITY_INFO, type Capability, capabilityOffText } from '@/shared/capabilities';

/**
 * A route that needs a capability (docs/MODULES.md → Capability gates)
 * answers 409 `capability_not_configured` while it is not configured: the
 * request was fine, the install just has no model for it. Returns the body to
 * send, or null when the capability is configured.
 */
export function capabilityRefused(set: { status?: number | string }, cap: Capability) {
  if (isCapabilityOn(cap)) return null;
  set.status = 409;
  return {
    error: capabilityOffText(cap),
    code: 'capability_not_configured' as const,
    capability: cap,
    setupHref: CAPABILITY_INFO[cap].setupHref,
  };
}
