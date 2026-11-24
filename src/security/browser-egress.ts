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
 * WebRTC is held to proxied UDP and QUIC is off (`BROWSER_HARDENING_ARGS`).
 * Not through the proxy: the browser's own DNS prefetch of names in a page.
 *
 * Behind the proxy, Playwright's `response.serverAddr()` is the proxy's own
 * address: the post-connect address checks do not apply to a proxied
 * context — the proxy already resolved, judged and pinned every connection.
 */
import { type EgressSubject, activeEgressPolicy, currentEgressSubject, egressDecider, egressPolicyActive } from './egress-policy';
import { EGRESS_REFUSED_HEADER, startEgressProxy, type EgressProxyOptions } from './egress-proxy';

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

/**
 * Chromium launch arguments for every headless browser Octipus starts:
 * WebRTC may not send UDP that does not go through a proxy (a page could
 * otherwise reach loopback or the LAN over STUN, around the egress proxy),
 * and QUIC (HTTP/3 over UDP) is off so every request is TCP the proxy sees.
 * Neither is used by agent browsing, so they apply with or without a policy:
 * the shared browser outlives a policy change.
 */
export const BROWSER_HARDENING_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic'];

/** Who a browser context was opened for: a context is not reused by another subject. */
export function egressSubjectKey(subject: EgressSubject | undefined): string {
  return JSON.stringify([subject?.userId ?? null, subject?.tool ?? null, subject?.role ?? null, subject?.roles ?? []]);
}

/** A navigation response, structurally (Playwright's `Response`). */
interface ProxiedResponse { status(): number; headers(): Record<string, string> }

/**
 * Throw when the egress proxy, not the site, answered a proxied navigation:
 * a plain-HTTP hop it refused carries `x-octipus-egress-refused`. (An HTTPS
 * hop it refused fails the navigation outright: see `explainProxyFailure`.)
 */
export function assertNotRefusedByProxy(response: ProxiedResponse | null | undefined): void {
  const reason = response?.headers()[EGRESS_REFUSED_HEADER];
  if (response && response.status() === 403 && reason) throw new Error(`Network access refused by the egress proxy: ${reason}. Do not retry this host; use an allowed source or ask the user.`);
}

/** A navigation error through the proxy, in words the model can act on. */
export function explainProxyFailure(error: unknown): Error {
  const message = (error as Error)?.message ?? String(error);
  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)
    ? new Error(`Network access refused by the egress proxy (the egress policy or the private-address guard). Do not retry this host; use an allowed source or ask the user. (${message.split('\n')[0]})`)
    : error instanceof Error ? error : new Error(message);
}
