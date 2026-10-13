import { channelLogger } from '@/utils/logger';
import { BaseChannel } from './interface';

export interface DiscoveredChannel {
  folder: string;
  channel: BaseChannel;
}

/**
 * The shipped channel folders: `src/channels/<name>/index.ts`, each exporting
 * a singleton instance of a `BaseChannel` subclass (typically `<name>Channel`).
 * Adding a channel is a folder plus one line here.
 *
 * This used to `readdirSync` its own directory and import each `index.ts` by
 * path. Once bundled that directory is `dist/`, which has no channel folders,
 * so the production build came up with `discovered: 0` and never started
 * Telegram, Slack, Teams or WhatsApp. Imports a bundler can see are the fix —
 * the same one `src/tools/discovery.ts` made.
 *
 * Each channel imports its vendor SDK (botbuilder, @slack/bolt, grammy) inside
 * `connect()`, so discovering an unconfigured channel costs only its own small
 * module, not the SDK.
 */
const CHANNEL_MODULES: Record<string, () => Promise<Record<string, unknown>>> = {
  slack: () => import('./slack'),
  teams: () => import('./teams'),
  telegram: () => import('./telegram'),
  webchat: () => import('./webchat'),
  whatsapp: () => import('./whatsapp'),
};

/**
 * The discovery loader does NOT decide whether to enable a channel — that
 * is left to each channel's `isEnabled(config)` method. So channels stay
 * dormant until their credentials appear in config.
 */
export async function discoverChannels(): Promise<DiscoveredChannel[]> {
  const found: DiscoveredChannel[] = [];

  for (const [name, load] of Object.entries(CHANNEL_MODULES)) {
    let mod: Record<string, unknown>;
    try {
      mod = await load();
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
    if (typeof value === 'function') {
      const ctor = value as { prototype?: unknown };
      if (ctor.prototype instanceof BaseChannel) {
        try {
          return new (value as new () => BaseChannel)();
        } catch (err) {
          channelLogger.warn({ err }, 'channel discovery: constructor threw — skipping');
        }
      }
    }
  }
  return null;
}
