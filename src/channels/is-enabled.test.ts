import { describe, expect, test } from 'vitest';
import type { Config } from '@/config/schema';
import { slackChannel } from './slack';
import { teamsChannel } from './teams';
import { telegramChannel } from './telegram';
import { webChatChannel } from './webchat';
import { whatsappChannel } from './whatsapp';

const empty = {} as Config;

describe('channel isEnabled(config) — typed contract', () => {
  test('webchat is always enabled (no creds needed)', () => {
    expect(webChatChannel.isEnabled(empty)).toBe(true);
  });

  test('telegram requires telegram.botToken', () => {
    expect(telegramChannel.isEnabled(empty)).toBe(false);
    expect(
      telegramChannel.isEnabled({ telegram: { botToken: 'x' } } as Config),
    ).toBe(true);
  });

  test('slack requires slack.botToken', () => {
    expect(slackChannel.isEnabled(empty)).toBe(false);
    expect(slackChannel.isEnabled({ slack: { botToken: 'x' } } as Config)).toBe(true);
  });

  test('whatsapp requires whatsapp.accessToken', () => {
    expect(whatsappChannel.isEnabled(empty)).toBe(false);
    expect(
      whatsappChannel.isEnabled({ whatsapp: { accessToken: 'x' } } as Config),
    ).toBe(true);
  });

  test('teams requires teams.appId', () => {
    expect(teamsChannel.isEnabled(empty)).toBe(false);
    expect(teamsChannel.isEnabled({ teams: { appId: 'x' } } as Config)).toBe(true);
  });

  test('empty string token treated as disabled (Boolean coercion)', () => {
    expect(telegramChannel.isEnabled({ telegram: { botToken: '' } } as Config)).toBe(false);
    expect(slackChannel.isEnabled({ slack: { botToken: '' } } as Config)).toBe(false);
  });
});
