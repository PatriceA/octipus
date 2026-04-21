import type { ToolManifest, } from '@/core/types';
import { getOAuthManager, OAUTH_VAULT_NAMES } from '@/security/oauth';
import { BaseTool, type ToolAvailability } from '../base-tool';
import { registerCalendarTools } from './calendar';
import { registerContactsTools } from './contacts';
import { registerDriveTools } from './drive';
import { registerGmailTools } from './gmail';
import { registerTasksTools } from './tasks';

export class GoogleWorkspaceTool extends BaseTool {
  readonly id = 'google-workspace';
  readonly name = 'Google Workspace';
  readonly version = '1.0.0';
  readonly description = 'Gmail, Calendar, Sheets, Docs, Drive, Contacts, and Tasks via Google APIs';

  override async checkAvailability(): Promise<ToolAvailability> {
    try {
      const { getVault } = await import('@/security/vault');
      const v = getVault();
      const clientId = await v.getByName('system', OAUTH_VAULT_NAMES.google.clientId);
      if (!clientId) return { available: false, reason: 'Google OAuth credentials not configured' };
      return { available: true };
    } catch {
      return { available: false, reason: 'Google OAuth credentials not configured' };
    }
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'email_read', description: 'Read Gmail messages, labels, and threads from your Google account', defaultLevel: 'ALLOW' },
        { action: 'email_send', description: 'Send new emails and reply to threads from your Gmail account', defaultLevel: 'ASK' },
        { action: 'calendar_read', description: 'Read Google Calendar events, schedules, and attendee info', defaultLevel: 'ALLOW' },
        { action: 'calendar_write', description: 'Create, update, and RSVP to Google Calendar events on your behalf', defaultLevel: 'ASK' },
        { action: 'docs_read', description: 'Read content from your Google Docs and Google Sheets', defaultLevel: 'ALLOW' },
        { action: 'docs_write', description: 'Create and edit Google Docs and Sheets in your Google Drive', defaultLevel: 'ASK' },
        { action: 'drive_read', description: 'List, search, and download files from your Google Drive', defaultLevel: 'ALLOW' },
        { action: 'drive_write', description: 'Upload and organize files in your Google Drive', defaultLevel: 'ASK' },
        { action: 'contacts_read', description: 'Read contact names, emails, and phone numbers from Google Contacts', defaultLevel: 'ALLOW' },
        { action: 'contacts_write', description: 'Create and update entries in your Google Contacts', defaultLevel: 'ASK' },
        { action: 'tasks_read', description: 'Read task lists and tasks from Google Tasks', defaultLevel: 'ALLOW' },
        { action: 'tasks_write', description: 'Create, update, and complete tasks in Google Tasks', defaultLevel: 'ASK' },
        { action: 'delete', description: 'Permanently delete Gmail messages, calendar events, Drive files, or tasks', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [],
    };
  }

  private async googleApi(userId: string, method: string, url: string, body?: unknown): Promise<unknown> {
    const token = await getOAuthManager().getValidToken(userId, 'google');
    if (!token) throw new Error('Google Workspace not connected. Connect your Google account in Settings > Integrations.');
    const response = await fetch(url, {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Google API error (${response.status}): ${JSON.stringify(error)}`);
    }
    if (response.status === 204) return { success: true };
    return response.json();
  }

  protected async registerTools(): Promise<void> {
    const register = this.registerTool.bind(this);
    const api = this.googleApi.bind(this);
    registerGmailTools(register, api);
    registerCalendarTools(register, api);
    registerDriveTools(register, api);
    registerContactsTools(register, api);
    registerTasksTools(register, api);
  }
}

export const googleWorkspaceTool = new GoogleWorkspaceTool();
