import { getSettingsService } from './settings-service';
import { refreshConfigKey } from './index';
import { resetLiteLLMClient } from '@/models/litellm-client';
import { reinitializeChannel } from '@/channels';
import { logger } from '@/utils/logger';
import type { ChannelType } from '@/core/types';

/**
 * Initialize hot-reload: subscribe to settings changes and route them
 * to the appropriate subsystems for live reconfiguration.
 */
export function initializeHotReload(): void {
  const svc = getSettingsService();

  svc.onChange(async (key: string, newValue: unknown, _oldValue: unknown) => {
    // Always update the cached config object
    refreshConfigKey(key, newValue);

    const category = key.split('.')[0];

    try {
      switch (category) {
        case 'litellm':
          // Recreate the OpenAI client with new baseURL/apiKey
          resetLiteLLMClient();
          logger.info({ key }, 'LiteLLM client reloaded');
          break;

        case 'telegram':
          await reinitializeChannel('telegram' as ChannelType);
          break;

        case 'slack':
          await reinitializeChannel('slack' as ChannelType);
          break;

        case 'teams':
          await reinitializeChannel('teams' as ChannelType);
          break;

        case 'logging':
          // Logger reconfiguration: pino doesn't support level change on the fly
          // but the logger reads config on each call in most setups.
          // At minimum, the next getConfig().logging.level will return the new value.
          logger.info({ key, value: newValue }, 'Logging config updated');
          break;

        // agent, orchestrator, workspace, voice, integrations —
        // these are read per-request from getConfig(), so no active reload needed.
        // The cached config was already updated by refreshConfigKey() above.
        default:
          logger.debug({ key, category }, 'Setting updated (no active reload needed)');
          break;
      }
    } catch (error) {
      logger.error({ error, key }, 'Hot-reload failed for setting');
    }
  });

  logger.info('Hot-reload initialized');
}
