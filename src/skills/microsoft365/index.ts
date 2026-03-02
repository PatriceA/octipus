import { BaseSkill, createParameterSchema } from '../base-skill';
import type { SkillManifest, AgentContext } from '@/core/types';
import { getOAuthManager } from '@/security/oauth';
import { registerMailTools } from './mail';
import { registerCalendarTools } from './calendar';
import { registerOneDriveTools } from './onedrive';
import { registerTodoTools } from './todo';
import { registerContactsTools } from './contacts';

export class Microsoft365Skill extends BaseSkill {
  readonly id = 'microsoft365';
  readonly name = 'Microsoft 365';
  readonly version = '1.0.0';
  readonly description = 'Outlook Mail, Calendar, OneDrive, To Do, and Contacts via Microsoft Graph';

  getManifest(): SkillManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'email_read', description: 'Read emails and folders', defaultLevel: 'ALLOW' },
        { action: 'email_send', description: 'Send and reply to emails', defaultLevel: 'ASK' },
        { action: 'calendar_read', description: 'Read calendars and events', defaultLevel: 'ALLOW' },
        { action: 'calendar_write', description: 'Create and update calendar events', defaultLevel: 'ASK' },
        { action: 'drive_read', description: 'List and download OneDrive files', defaultLevel: 'ALLOW' },
        { action: 'drive_write', description: 'Upload files to OneDrive', defaultLevel: 'ASK' },
        { action: 'tasks_read', description: 'Read To Do lists and tasks', defaultLevel: 'ALLOW' },
        { action: 'tasks_write', description: 'Create and complete tasks', defaultLevel: 'ASK' },
        { action: 'contacts_read', description: 'Read contacts', defaultLevel: 'ALLOW' },
        { action: 'contacts_write', description: 'Create and update contacts', defaultLevel: 'ASK' },
        { action: 'delete', description: 'Delete emails, events, files, or tasks', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [],
    };
  }

  private async graphApi(userId: string, method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await getOAuthManager().getValidToken(userId, 'microsoft');
    if (!token) throw new Error('Microsoft 365 not connected. Connect your Microsoft account in Settings > Integrations.');
    const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
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

export const microsoft365Skill = new Microsoft365Skill();
