/**
 * Where the mail and calendar scopes of the plugin host API reach
 * (docs/PLUGIN-PACKAGES.md#mail-and-calendar), and whether the calling user
 * may reach it now.
 *
 * - `mail`: the Mail module's mailboxes (IMAP/SMTP, stored in Octipus with a
 *   protection level per message), personal or a space's, through the user's
 *   content scope.
 * - `inbox`: the Gmail or Microsoft 365 inbox the user connected (the Inbox
 *   module, read live from the provider; Google first when both are
 *   connected, as the Inbox page does). Its messages carry no protection
 *   level, so they count as unclear: level 4.
 * - The calendars the user connected (Google, Microsoft 365, the Inbox
 *   module), at the level an admin sets (`plugins.calendarProtectionLevel`).
 *
 * The connected accounts are the user's own: a call that ran in a shared
 * space does not reach them (as the Calendar page refuses in a space). Each
 * source's module must be on, and the user's permission rules on that
 * source's own tool action must not deny it, as for the user's own agent (an
 * ASK is not a denial: the plugin tool's call was what was asked about).
 */
import type { AgentContext } from '@/core/types';
import type { Principal } from '@/security/principal';
import type { HostTokenGrant } from './host-api';

export type MailSource = 'mail' | 'inbox';
export type InboxProvider = 'google' | 'microsoft';
export type MailAction = 'read' | 'draft' | 'send';
export type CalendarAction = 'read' | 'write';

export interface SourceRefusal { status: number; code: string; error: string }

/** The tool and action of the user's rules that stand for each source's action. */
const MAIL_RULE: Record<'mail' | InboxProvider, Record<MailAction, { toolId: string; action: string }>> = {
  mail: { read: { toolId: 'mail', action: 'read' }, draft: { toolId: 'mail', action: 'draft' }, send: { toolId: 'mail', action: 'send' } },
  // The providers' tools have no action of their own for drafts: a draft goes
  // into the account's mailbox, so the send action's rule decides it.
  google: { read: { toolId: 'google-workspace', action: 'email_read' }, draft: { toolId: 'google-workspace', action: 'email_send' }, send: { toolId: 'google-workspace', action: 'email_send' } },
  microsoft: { read: { toolId: 'microsoft365', action: 'email_read' }, draft: { toolId: 'microsoft365', action: 'email_send' }, send: { toolId: 'microsoft365', action: 'email_send' } },
};

const CALENDAR_RULE: Record<InboxProvider, Record<CalendarAction, { toolId: string; action: string }>> = {
  google: { read: { toolId: 'google-workspace', action: 'calendar_read' }, write: { toolId: 'google-workspace', action: 'calendar_write' } },
  microsoft: { read: { toolId: 'microsoft365', action: 'calendar_read' }, write: { toolId: 'microsoft365', action: 'calendar_write' } },
};

async function ruleDenies(grant: HostTokenGrant, rule: { toolId: string; action: string }): Promise<boolean> {
  const { getPermissionManager } = await import('@/security/permissions');
  const scope: Pick<AgentContext, 'sessionId' | 'workspaceId'> = { sessionId: grant.sessionId ?? '', workspaceId: grant.workspaceId };
  const check = await getPermissionManager().check(grant.userId, rule.toolId, rule.action, {}, scope);
  return check.level === 'DENY';
}

const denied = (what: string): SourceRefusal => ({ status: 403, code: 'denied_by_rule', error: `Your permission rules do not allow ${what}` });

/** A connected account is the user's own: refused in a shared space. */
export function personalOnly(principal: Principal, what: string): SourceRefusal | null {
  if (principal.workspaceKind !== 'shared') return null;
  return { status: 403, code: 'personal_only', error: `${what} belongs to your personal workspace; this call ran in a space` };
}

/** Whether the Mail module's mailboxes may be reached for `action` now. */
export async function mailModuleRefusal(grant: HostTokenGrant, action: MailAction): Promise<SourceRefusal | null> {
  const { isToolOn } = await import('@/core/modules/registry');
  if (!isToolOn('mail')) return { status: 404, code: 'module_off', error: 'The Mail module is not enabled' };
  return (await ruleDenies(grant, MAIL_RULE.mail[action])) ? denied(`mail ${action}`) : null;
}

/**
 * The connected inbox's provider for `action`, or the refusal: personal
 * workspace only, the Inbox module on, a provider connected, the user's
 * rules on that provider's mail action not denying it.
 */
export async function inboxProvider(
  grant: HostTokenGrant, principal: Principal, action: MailAction,
  deps: { detect?: (userId: string) => Promise<InboxProvider | null> } = {},
): Promise<{ provider: InboxProvider } | SourceRefusal> {
  const personal = personalOnly(principal, 'The connected inbox');
  if (personal) return personal;
  const { isModuleOn } = await import('@/core/modules/registry');
  if (!isModuleOn('inbox')) return { status: 404, code: 'module_off', error: 'The Inbox module (Google, Microsoft 365) is not enabled' };
  const detect = deps.detect ?? (async (userId: string) => (await import('@/core/email/providers')).detectProvider(userId));
  const provider = await detect(grant.userId);
  if (!provider) return { status: 404, code: 'not_connected', error: 'No Gmail or Microsoft 365 account is connected' };
  return (await ruleDenies(grant, MAIL_RULE[provider][action])) ? denied(`mail ${action} in your ${provider} account`) : { provider };
}

/** Whether the connected calendars may be reached for `action` (and `provider`, for a write) now. */
export async function calendarRefusal(
  grant: HostTokenGrant, principal: Principal, action: CalendarAction, providers: readonly InboxProvider[],
): Promise<SourceRefusal | null> {
  const personal = personalOnly(principal, 'The connected calendar');
  if (personal) return personal;
  const { isModuleOn } = await import('@/core/modules/registry');
  if (!isModuleOn('inbox')) return { status: 404, code: 'module_off', error: 'The Inbox module (Google, Microsoft 365) is not enabled' };
  for (const provider of providers) {
    if (await ruleDenies(grant, CALENDAR_RULE[provider][action])) return denied(`calendar ${action} in your ${provider} account`);
  }
  return null;
}
