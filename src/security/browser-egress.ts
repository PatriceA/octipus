/**
 * The egress policy for the headless browser (docs/EGRESS-POLICY.md#browser-pages).
 *
 * Playwright cannot pin a connection to a checked address, and its request
 * interception does not see redirect hops. So, while a policy is active, a
 * browser context opened inside a tool call is routed through its own egress
 * proxy (src/security/egress-proxy.ts, `anyHost` + the policy): every request
 * the page makes — the navigation, each redirect hop, sub-resources, a
 * script's fetch, a click's navigation — is judged by name and by the
 * addresses it resolves to BEFORE it is sent, and private addresses are
 * refused there as everywhere. `<-loopback>` removes Chromium's implicit
 * proxy bypass for localhost, so loopback goes to the proxy (and is refused)
 * too.
 *
 * Not through the proxy: WebRTC (UDP) and the browser's own DNS prefetch of
 * names in a page; documented as limits.
 */
import { type EgressSubject, activeEgressPolicy, currentEgressSubject, egressDecider, egressPolicyActive } from './egress-policy';
import { startEgressProxy, type EgressProxyOptions } from './egress-proxy';

export interface BrowserEgress {
  /** Playwright's `newContext({ proxy })` option. */
  proxy: { server: string; bypass: string };
  close(): void;
}

/**
 * A proxy for one browser context of the current tool call, or null when no
 * policy applies (no subject, or no active policy): the context is then
 * opened exactly as before.
 */
export async function browserEgressFor(subject: EgressSubject | undefined = currentEgressSubject(), overrides: Pick<EgressProxyOptions, 'resolve' | 'allowPrivateAddresses'> = {}): Promise<BrowserEgress | null> {
  if (!subject || !egressPolicyActive(activeEgressPolicy())) return null;
  const proxy = await startEgressProxy({
    label: `browser:${subject.tool ?? 'browser'}`, allowed: [], anyHost: true,
    decide: egressDecider(subject, 'browser'), ...overrides,
  });
  return { proxy: { server: proxy.url, bypass: '<-loopback>' }, close: () => { void proxy.close(); } };
}

/** Thrown when a context opened before the policy applied would be reused under it. */
export function unproxiedContextError(): Error {
  return new Error('This browser context was opened before the egress policy applied, so its traffic is not judged. Open a new page (without contextId, or with a new one).');
}
