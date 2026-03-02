import { BaseSkill, createParameterSchema } from '../base-skill';
import type { SkillManifest, AgentContext } from '@/core/types';
import { getOAuthManager } from '@/security/oauth';
import { registerGmailTools } from './gmail';
import { registerCalendarTools } from './calendar';
import { registerDriveTools } from './drive';
import { registerContactsTools } from './contacts';
import { registerTasksTools } from './tasks';

export class GoogleWorkspaceSkill extends BaseSkill {
  readonly id = 'google-workspace';
  readonly name = 'Google Workspace';
  readonly version = '1.0.0';
  readonly description = 'Gmail, Calendar, Sheets, Docs, Drive, Contacts, and Tasks via Google APIs';

  getManifest(): SkillManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'email_read', description: 'Read emails and labels', defaultLevel: 'ALLOW' },
        { action: 'email_send', description: 'Send and reply to emails', defaultLevel: 'ASK' },
        { action: 'calendar_read', description: 'Read calendars and events', defaultLevel: 'ALLOW' },
        { action: 'calendar_write', description: 'Create and update calendar events', defaultLevel: 'ASK' },
        { action: 'docs_read', description: 'Read Google Docs and Sheets', defaultLevel: 'ALLOW' },
        { action: 'docs_write', description: 'Create and edit Google Docs and Sheets', defaultLevel: 'ASK' },
        { action: 'drive_read', description: 'List and download Drive files', defaultLevel: 'ALLOW' },
        { action: 'drive_write', description: 'Upload files to Drive', defaultLevel: 'ASK' },
        { action: 'contacts_read', description: 'Read contacts', defaultLevel: 'ALLOW' },
        { action: 'contacts_write', description: 'Create and update contacts', defaultLevel: 'ASK' },
        { action: 'tasks_read', description: 'Read task lists and tasks', defaultLevel: 'ALLOW' },
        { action: 'tasks_write', description: 'Create and complete tasks', defaultLevel: 'ASK' },
        { action: 'delete', description: 'Delete emails, events, files, or tasks', defaultLevel: 'ASK', dangerous: true },
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

export const googleWorkspaceSkill = new GoogleWorkspaceSkill();
