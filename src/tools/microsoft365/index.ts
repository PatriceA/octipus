import type { ToolManifest, } from '@/core/types';
import { fetchWithTimeout } from '@/utils/http';
import { getOAuthManager, OAUTH_VAULT_NAMES } from '@/security/oauth';
import { BaseTool, type ToolAvailability } from '../base-tool';
import { registerCalendarTools } from './calendar';
import { registerContactsTools } from './contacts';
import { registerMailTools } from './mail';
import { registerOneDriveTools } from './onedrive';
import { registerTodoTools } from './todo';

export class Microsoft365Tool extends BaseTool {
  readonly id = 'microsoft365';
  readonly name = 'Microsoft 365';
  readonly version = '1.0.0';
  readonly description = 'Outlook Mail, Calendar, OneDrive, To Do, and Contacts via Microsoft Graph';

  override async checkAvailability(): Promise<ToolAvailability> {
    try {
      const { getVault } = await import('@/security/vault');
      const v = getVault();
      const clientId = await v.getByName('system', OAUTH_VAULT_NAMES.microsoft.clientId);
      if (!clientId) return { available: false, reason: 'Microsoft OAuth credentials not configured' };
      return { available: true };
    } catch {
      return { available: false, reason: 'Microsoft OAuth credentials not configured' };
    }
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'email_read', description: 'Read Outlook emails, folders, and threads from your Microsoft 365 account', defaultLevel: 'ALLOW' },
        { action: 'email_send', description: 'Send new emails and reply to threads from your Outlook account', defaultLevel: 'ASK' },
        { action: 'calendar_read', description: 'Read calendar events, schedules, and attendee info from Outlook Calendar', defaultLevel: 'ALLOW' },
        { action: 'calendar_write', description: 'Create, update, and RSVP to events in your Outlook Calendar', defaultLevel: 'ASK' },
        { action: 'drive_read', description: 'List, search, and download files from your OneDrive', defaultLevel: 'ALLOW' },
        { action: 'drive_write', description: 'Upload and organize files in your OneDrive', defaultLevel: 'ASK' },
        { action: 'tasks_read', description: 'Read task lists and tasks from Microsoft To Do', defaultLevel: 'ALLOW' },
        { action: 'tasks_write', description: 'Create, update, and complete tasks in Microsoft To Do', defaultLevel: 'ASK' },
        { action: 'contacts_read', description: 'Read contact names, emails, and phone numbers from Outlook Contacts', defaultLevel: 'ALLOW' },
        { action: 'contacts_write', description: 'Create and update entries in your Outlook Contacts', defaultLevel: 'ASK' },
        { action: 'delete', description: 'Permanently delete Outlook emails, calendar events, OneDrive files, or tasks', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [],
    };
  }

  private async graphApi(userId: string, method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await getOAuthManager().getValidToken(userId, 'microsoft');
    if (!token) throw new Error('Microsoft 365 not connected. Connect your Microsoft account in Settings > Integrations.');
    const response = await fetchWithTimeout(`https://graph.microsoft.com/v1.0${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Microsoft Graph error (${response.status}): ${JSON.stringify(error)}`);
    }
    if (response.status === 204) return { success: true };
    return response.json();
  }

  protected async registerTools(): Promise<void> {
    const register = this.registerTool.bind(this);
    const api = this.graphApi.bind(this);
    registerMailTools(register, api);
    registerCalendarTools(register, api);
    registerOneDriveTools(register, api);
    registerTodoTools(register, api);
    registerContactsTools(register, api);
  }
}

export const microsoft365Tool = new Microsoft365Tool();
