import { BaseChannel } from '@/channels/interface';
import type { ChannelResponse } from '@/core/types';

export default class QaDemoChannel extends BaseChannel {
  readonly type = 'qa-demo' as const;
  readonly name = 'QA Demo Channel';
  override isEnabled() { return false; }
  async connect() { /* dormant */ }
  async disconnect() { /* dormant */ }
  async send(channelId: string, response: ChannelResponse): Promise<string> { /* dormant */ return ''; }
  }