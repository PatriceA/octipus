/**
 * Whether a model counts as running locally (docs/PROTECTION-LEVELS.md).
 * Shared by the backend (decision policy, model validation) and the web
 * model editor, so both draw the same line.
 */

/** The data policy of a model served on this machine or the owner's own network. */
export const LOCAL_DATA_POLICY = { hosting: 'local', retention: 'none', trainsOnInput: false } as const;

/**
 * Is `url` on this machine or a private network: localhost, a private or
 * link-local IPv4/IPv6 address, a single-label host, or a .local / .lan /
 * .internal / .home name. Anything else (a public address or domain) is not.
 */
export function isPrivateEndpoint(url: string | null | undefined): boolean {
  if (!url) return false;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (host === 'localhost' || host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
  const ip = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (host.includes(':')) return false; // any other IPv6 literal is public
  return !host.includes('.') || /\.(local|lan|internal|home)$/.test(host);
}

/** Providers whose rows are local by what they are (no endpoint to check). */
const LOCAL_BY_NATURE = new Set(['local-audio', 'local-engine']);

/**
 * Why a row may not be marked as running locally, or null when it may. Only
 * a model served at a private endpoint can be: a CLI agent runs on its
 * vendor's servers, and a public endpoint is someone else's machine.
 */
export function localHostingProblem(provider: string, endpoint: string | null | undefined, policy: { hosting?: string } | null | undefined): string | null {
  if (policy?.hosting !== 'local') return null;
  if (LOCAL_BY_NATURE.has(provider)) return null;
  if (provider === 'cli' || provider === 'litellm') return `A ${provider === 'cli' ? 'CLI agent' : 'LiteLLM proxy'} model cannot be marked as running locally: it forwards to another service.`;
  if (!isPrivateEndpoint(endpoint)) {
    return 'Only a model served on this machine or your own network can be marked as running locally: its endpoint must be localhost, a private address, or a .local/.lan host.';
  }
  return null;
}
