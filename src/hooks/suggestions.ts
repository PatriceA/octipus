import { getOAuthManager } from '@/security/oauth';
import { getUMI } from '@/channels/interface';
import { coreLogger } from '@/utils/logger';

export interface HookSuggestion {
  id: string;
  name: string;
  description: string;
  integration: 'google' | 'microsoft' | 'github' | 'telegram';
  trigger: string;
  triggerConfig: Record<string, unknown>;
  action: string;
  actionConfig: Record<string, unknown>;
}

export async function getHookSuggestions(userId: string): Promise<HookSuggestion[]> {
  const suggestions: HookSuggestion[] = [];
  const oauthManager = getOAuthManager();

  // Check Google OAuth
  try {
    const googleToken = await oauthManager.getValidToken(userId, 'google');
    if (googleToken) {
      suggestions.push({
        id: 'google-email-check',
        name: 'Check Gmail periodically',
        description: 'Check for new unread emails every 30 minutes and summarize them',
        integration: 'google',
        trigger: 'schedule',
        triggerConfig: { cronExpression: '*/30 * * * *' },
        action: 'spawn_agent',
        actionConfig: {
          agentTopic: 'communication',
          agentRole: 'communication',
          agentPrompt: 'Check for new unread emails in Gmail and provide a summary of important messages.',
        },
      });
      suggestions.push({
        id: 'google-calendar-reminder',
        name: 'Daily calendar summary',
        description: 'Get a summary of today\'s calendar events every morning',
        integration: 'google',
        trigger: 'schedule',
        triggerConfig: { cronExpression: '0 9 * * *' },
        action: 'spawn_agent',
        actionConfig: {
          agentTopic: 'communication',
          agentRole: 'communication',
          agentPrompt: 'List today\'s calendar events from Google Calendar and summarize the schedule.',
        },
      });
    }
  } catch {
    // Google OAuth not configured
  }

  // Check Microsoft OAuth
  try {
    const msToken = await oauthManager.getValidToken(userId, 'microsoft');
    if (msToken) {
      suggestions.push({
        id: 'ms-email-check',
        name: 'Check Outlook periodically',
        description: 'Check for new unread Outlook emails every 30 minutes',
        integration: 'microsoft',
        trigger: 'schedule',
        triggerConfig: { cronExpression: '*/30 * * * *' },
        action: 'spawn_agent',
        actionConfig: {
          agentTopic: 'communication',
          agentRole: 'communication',
          agentPrompt: 'Check for new unread emails in Outlook and provide a summary of important messages.',
        },
      });
    }
  } catch {
    // Microsoft OAuth not configured
  }

  // Check Telegram channel
  try {
    const umi = getUMI();
    if (umi.isChannelAvailable('telegram' as any)) {
      suggestions.push({
        id: 'telegram-daily-digest',
        name: 'Daily digest to Telegram',
        description: 'Send a daily summary of activity to your Telegram',
        integration: 'telegram',
        trigger: 'schedule',
        triggerConfig: { cronExpression: '0 18 * * *' },
        action: 'send_message',
        actionConfig: {
          notifyMessage: 'Daily activity digest',
          notifyChannels: ['telegram'],
        },
      });
    }
  } catch {}

  return suggestions;
}
