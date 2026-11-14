/**
 * Short-lived public links to one media file, for a channel that can only
 * fetch a URL (Teams audio, Teams images over 1 MB). The token is random and
 * unguessable, the bytes are held in memory, and a link expires after 15
 * minutes. Without a public address (`oauth.publicUrl` / `PUBLIC_URL`) there
 * is no link: the channel says the file is in the web app instead.
 */
import { randomBytes } from 'node:crypto';
import { publicLinkBase } from '@/core/public-url';

const TTL_MS = 15 * 60_000;
const MAX_LINKS = 200;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const links = new Map<string, { data: Buffer; mimeType: string; filename: string; expiresAt: number }>();

function prune(now = Date.now()): void {
  for (const [token, link] of links) if (link.expiresAt <= now) links.delete(token);
  let total = [...links.values()].reduce((n, l) => n + l.data.length, 0);
  for (const token of links.keys()) {
    if (links.size <= MAX_LINKS && total <= MAX_TOTAL_BYTES) break;
    total -= links.get(token)?.data.length ?? 0;
    links.delete(token);
  }
}

/** A public URL serving `data` for 15 minutes, or null without a public address. */
export function publicMediaUrl(data: Buffer, mimeType: string, filename: string): string | null {
  const base = publicLinkBase();
  if (!/^https?:\/\//.test(base)) return null;
  prune();
  const token = randomBytes(24).toString('base64url');
  links.set(token, { data, mimeType, filename, expiresAt: Date.now() + TTL_MS });
  return `${base}/api/media/public/${token}`;
}

/** The media behind a token, while it lives. */
export function publicMedia(token: string): { data: Buffer; mimeType: string; filename: string } | null {
  prune();
  return links.get(token) ?? null;
}

/** For tests. */
export function resetPublicLinksForTest(): void { links.clear(); }
