import { readdirSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { channelLogger } from '@/utils/logger';
import { BaseChannel } from './interface';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface DiscoveredChannel {
  folder: string;
  channel: BaseChannel;
}

/**
 * Auto-discover channel folders under `src/channels/<name>/`.
 *
 * Convention (matches roles + tools drop-folder pattern):
 *
 *   src/channels/<name>/index.ts — exports a singleton instance of a
 *   `BaseChannel` subclass (typically `<name>Channel`).
 *
 * The discovery loader does NOT decide whether to enable a channel — that
 * is left to each channel's `isEnabled(config)` method. So channels can be
 * dropped into the tree and stay dormant until their credentials appear
 * in config.
 */
export async function discoverChannels(): Promise<DiscoveredChannel[]> {
  const found: DiscoveredChannel[] = [];
  const entries = readdirSync(HERE);

  for (const name of entries) {
    const dir = resolve(HERE, name);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;

    const indexPath = resolve(dir, 'index.ts');
    let mod: Record<string, unknown>;
    try {
      mod = await import(indexPath) as Record<string, unknown>;
    } catch (err) {
      channelLogger.warn({ folder: name, err }, 'channel discovery: import failed — skipping');
      continue;
    }

    const channel = pickChannel(mod);
    if (channel) {
      found.push({ folder: name, channel });
    } else {
      channelLogger.debug({ folder: name }, 'channel discovery: no BaseChannel export — skipping');
    }
  }

  return found;
}

function pickChannel(mod: Record<string, unknown>): BaseChannel | null {
  for (const value of Object.values(mod)) {
    if (value instanceof BaseChannel) return value;
  }
  return null;
}
