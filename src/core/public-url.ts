/**
 * The absolute base of links handed to a person outside the web app: the
 * `oauth.publicUrl` setting (env `PUBLIC_URL`), the address other devices
 * reach this install at. Empty when neither is configured — callers then
 * fall back to a root-relative path or the address the request came in on.
 */
import { getSettingsService } from '@/config/settings-service';

export function publicLinkBase(): string {
  try {
    const raw = getSettingsService().getSync('oauth.publicUrl');
    if (typeof raw === 'string' && raw) return raw.replace(/\/$/, '');
  } catch {
    // settings service not initialised (e.g. test boot order) — fall through.
  }
  return process.env.PUBLIC_URL?.replace(/\/$/, '') ?? '';
}
