/**
 * Which mail hosts an account may connect to (docs/MAIL.md#hosts).
 *
 * A mail server is reached by name from the Octipus server, so a mailbox
 * setting is a way to make the server open connections: pointed at an
 * internal address it could probe the local network. So:
 *
 * - A host that resolves to a private, loopback or link-local address is
 *   on the local network. Only an admin can allow that (the KIM client
 *   module, an on-prem Exchange); the account then carries `localNetwork`.
 * - Unencrypted connections (`none`) are only for the local network.
 * - The name is resolved once per connection and the connection pinned to
 *   that address (TLS still checks the certificate against the name), so a
 *   name that resolves to a public address at the check cannot point to a
 *   private one at connect.
 */
import { promises as dns } from 'node:dns';
import { isIpLiteral, isPrivateIP, looksLikeNonStandardIpLiteral } from '@/utils/sanitize';
import type { MailSecurity } from '@/shared/mail';

export class MailHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailHostError';
  }
}

export interface PinnedHost {
  /** The address to connect to. */
  address: string;
  /** The name to check the certificate against (undefined for an IP literal). */
  servername: string | undefined;
  /** The host is on the local network. */
  local: boolean;
}

/** Host names that never leave the machine, whatever DNS says. */
function isLocalName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

/** Resolve `host` and say whether it is on the local network. Throws `MailHostError`. */
export async function resolveMailHost(rawHost: string, lookup = dns.lookup): Promise<PinnedHost> {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || /[\s/]/.test(host)) throw new MailHostError('The host name is not valid');
  if (looksLikeNonStandardIpLiteral(host)) throw new MailHostError(`Ambiguous IP address: ${host}`);
  if (isIpLiteral(host)) return { address: host, servername: undefined, local: isPrivateIP(host) };
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new MailHostError(`The host ${host} could not be resolved`);
  }
  if (addresses.length === 0) throw new MailHostError(`The host ${host} could not be resolved`);
  // One private address makes the host local: a name answering both is not public.
  const local = isLocalName(host) || addresses.some((a) => isPrivateIP(a.address));
  return { address: addresses[0].address, servername: host, local };
}

/**
 * Refuse a connection the account may not open: a local host without the
 * admin's allowance, or an unencrypted one off the local network.
 */
export function assertHostAllowed(pinned: PinnedHost, security: MailSecurity, localNetwork: boolean, host: string): void {
  if (pinned.local && !localNetwork) {
    throw new MailHostError(`${host} is on the local network; only an admin can set up a mailbox there`);
  }
  if (security === 'none' && !pinned.local) {
    throw new MailHostError(`An unencrypted connection to ${host} is refused; use TLS or STARTTLS`);
  }
}

/** Resolve and check in one step: the address to connect to. */
export async function pinMailHost(host: string, security: MailSecurity, localNetwork: boolean): Promise<PinnedHost> {
  const pinned = await resolveMailHost(host);
  assertHostAllowed(pinned, security, localNetwork, host);
  return pinned;
}
