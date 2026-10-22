/**
 * Setting mail accounts up (docs/MAIL.md#accounts): checking what a person
 * entered, deciding the account's `localNetwork` allowance (hosts.ts), the
 * passwords in the vault, and the views the API returns.
 *
 * Personally a user sets up their own mailboxes; a space's functional
 * mailboxes are set up by its owners. A host on the local network needs an
 * admin, whoever sets the rest up.
 */
import type { ContentRepos } from '@/db/repositories/content';
import type { MailAccountWrite } from '@/db/repositories/mail';
import type { MailAccount, MailMessage } from '@/db/schema/mail';
import { isAdmin } from '@/security/principal';
import {
  MAIL_PROTOCOLS,
  MAIL_SECURITY,
  type MailAccountView,
  type MailMessageSummary,
  type MailMessageView,
  type MailProtocol,
  type MailServer,
} from '@/shared/mail';
import type { MailSummaryRow } from '@/db/repositories/mail';
import { isMailAddress, MailInputError } from './drafts';
import { assertHostAllowed, MailHostError, resolveMailHost } from './hosts';
import { deleteMailPasswords, mailPassword, mailPasswordsSet, outgoingPassword, setMailPassword } from './secrets';
import { checkOutgoing } from './send';
import { checkIncoming } from './sources';

export interface MailServerInput {
  host: string;
  port: number;
  security: string;
  username?: string;
}

export interface MailAccountInput {
  label?: string;
  address?: string;
  displayName?: string | null;
  protocol?: string;
  incoming?: MailServerInput;
  outgoing?: MailServerInput | null;
  folder?: string;
  enabled?: boolean;
}

export interface MailPasswordsInput {
  incoming?: string | null;
  outgoing?: string | null;
}

function server(input: MailServerInput, address: string, side: string): MailServer {
  const host = input.host?.trim().toLowerCase();
  if (!host || host.length > 253) throw new MailInputError(`The ${side} host is missing`);
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new MailInputError(`The ${side} port is not valid`);
  if (!(MAIL_SECURITY as readonly string[]).includes(input.security)) throw new MailInputError(`The ${side} security must be one of ${MAIL_SECURITY.join(', ')}`);
  const username = (input.username ?? '').trim() || address;
  if (username.length > 320 || /[\r\n]/.test(username)) throw new MailInputError(`The ${side} user name is not valid`);
  return { host, port: input.port, security: input.security as MailServer['security'], username };
}

/**
 * Whether the servers may be used and whether they need the local-network
 * allowance. Resolves each host. Throws `MailHostError` / `MailInputError`.
 */
async function localNetworkFor(servers: MailServer[], admin: boolean): Promise<boolean> {
  let local = false;
  for (const s of servers) {
    const pinned = await resolveMailHost(s.host);
    // An admin's save allows the local network; anyone else's is checked without it.
    assertHostAllowed(pinned, s.security, admin, s.host);
    local ||= pinned.local;
  }
  return local;
}

/** The account a create writes, checked. */
async function accountWrite(input: MailAccountInput, admin: boolean): Promise<MailAccountWrite> {
  const address = input.address?.trim() ?? '';
  if (!isMailAddress(address)) throw new MailInputError('The address is not an email address');
  const label = input.label?.trim() || address;
  const protocol = (input.protocol ?? 'imap') as MailProtocol;
  if (!(MAIL_PROTOCOLS as readonly string[]).includes(protocol)) throw new MailInputError(`The protocol must be one of ${MAIL_PROTOCOLS.join(', ')}`);
  if (!input.incoming) throw new MailInputError('The incoming server is missing');
  const incoming = server(input.incoming, address, 'incoming');
  const outgoing = input.outgoing ? server(input.outgoing, address, 'outgoing') : null;
  const folder = protocol === 'imap' ? (input.folder?.trim() || 'INBOX') : 'INBOX';
  if (folder.length > 200 || /[\r\n]/.test(folder)) throw new MailInputError('The folder name is not valid');
  return {
    label: label.slice(0, 100),
    address,
    displayName: input.displayName?.replace(/[\r\n"<>]+/g, ' ').trim().slice(0, 100) || null,
    protocol,
    incoming,
    outgoing,
    folder,
    enabled: input.enabled ?? true,
    localNetwork: await localNetworkFor(outgoing ? [incoming, outgoing] : [incoming], admin),
  };
}

export async function createMailAccount(repos: ContentRepos, input: MailAccountInput, passwords: MailPasswordsInput = {}): Promise<MailAccount> {
  // The role first: hosts are resolved only for someone who may set the account up.
  repos.mail.assertManage();
  const write = await accountWrite(input, isAdmin(repos.principal));
  const account = await repos.mail.createAccount(write);
  try {
    if (passwords.incoming) await setMailPassword(account.id, 'incoming', passwords.incoming);
    if (passwords.outgoing) await setMailPassword(account.id, 'outgoing', passwords.outgoing);
  } catch (err) {
    await repos.mail.deleteAccount(account.id).catch(() => undefined);
    throw err;
  }
  return account;
}

/**
 * Change an account. Fields not given stay. A change of address, protocol,
 * servers or folder is checked like a new account (the local-network
 * allowance decided again) and starts the sync over.
 */
export async function updateMailAccount(repos: ContentRepos, id: string, input: MailAccountInput, passwords: MailPasswordsInput = {}): Promise<MailAccount | null> {
  const current = await repos.mail.account(id);
  if (!current) return null;
  repos.mail.assertManage();
  const connection = input.address !== undefined || input.protocol !== undefined || input.incoming !== undefined
    || input.outgoing !== undefined || input.folder !== undefined;
  let patch: Partial<MailAccountWrite>;
  if (connection) {
    const merged = await accountWrite({
      label: input.label ?? current.label,
      address: input.address ?? current.address,
      displayName: input.displayName !== undefined ? input.displayName : current.displayName,
      protocol: input.protocol ?? current.protocol,
      incoming: input.incoming ?? current.incoming,
      outgoing: input.outgoing !== undefined ? input.outgoing : current.outgoing,
      folder: input.folder ?? current.folder,
      enabled: input.enabled ?? current.enabled,
    }, isAdmin(repos.principal));
    patch = merged;
  } else {
    patch = {};
    if (input.label !== undefined) patch.label = input.label.trim().slice(0, 100) || current.address;
    if (input.displayName !== undefined) patch.displayName = input.displayName?.replace(/[\r\n"<>]+/g, ' ').trim().slice(0, 100) || null;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
  }
  const serversChanged = connection && (
    JSON.stringify([patch.protocol, patch.incoming, patch.folder]) !== JSON.stringify([current.protocol, current.incoming, current.folder])
  );
  const row = await repos.mail.updateAccount(id, patch, { resetSync: serversChanged });
  if (!row) return null;
  // A password goes only to the server it was entered for: a server moved to
  // another host, port or user name forgets it unless a new one comes along.
  const moved = (a: MailServer | null, b: MailServer | null) => !!a && (!b || a.host !== b.host || a.port !== b.port || a.username !== b.username);
  const incoming = passwords.incoming !== undefined ? passwords.incoming : moved(current.incoming, row.incoming) ? null : undefined;
  const outgoing = passwords.outgoing !== undefined ? passwords.outgoing : moved(current.outgoing, row.outgoing) ? null : undefined;
  if (incoming !== undefined) await setMailPassword(id, 'incoming', incoming);
  if (outgoing !== undefined) await setMailPassword(id, 'outgoing', outgoing);
  return row;
}

export async function deleteMailAccount(repos: ContentRepos, id: string): Promise<boolean> {
  const removed = await repos.mail.deleteAccount(id);
  if (removed) await deleteMailPasswords(id);
  return removed;
}

/** Log in to the account's servers with the stored passwords. Returns what failed, per side. */
export async function testMailAccount(account: MailAccount): Promise<{ incoming: string | null; outgoing: string | null }> {
  const result = { incoming: null as string | null, outgoing: null as string | null };
  const failure = (err: unknown) => {
    const e = err as { authenticationFailed?: boolean; responseText?: string; response?: string; message?: string };
    if (e?.authenticationFailed) return 'The server refused the login';
    return (e?.responseText || e?.response || e?.message || String(err)).replace(/\s+/g, ' ').trim().slice(0, 300);
  };
  const incoming = await mailPassword(account.id, 'incoming');
  if (!incoming) result.incoming = 'No password is stored';
  else await checkIncoming(account, incoming).catch((err) => { result.incoming = failure(err); });
  if (account.outgoing) {
    const outgoing = await outgoingPassword(account);
    if (!outgoing) result.outgoing = 'No password is stored';
    else await checkOutgoing(account, outgoing).catch((err) => { result.outgoing = failure(err); });
  }
  return result;
}

// ── Views ───────────────────────────────────────────────────────────

export async function accountViews(rows: readonly MailAccount[]): Promise<MailAccountView[]> {
  const set = await mailPasswordsSet(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    label: r.label,
    address: r.address,
    displayName: r.displayName,
    protocol: r.protocol,
    incoming: r.incoming,
    outgoing: r.outgoing,
    folder: r.folder,
    enabled: r.enabled,
    passwordSet: set.get(r.id) ?? { incoming: false, outgoing: false },
    lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
  }));
}

export function messageSummary(row: MailSummaryRow): MailMessageSummary {
  return {
    id: row.id,
    accountId: row.accountId,
    status: row.status,
    from: row.fromAddress,
    to: row.toAddresses,
    subject: row.subject,
    snippet: row.snippet,
    date: row.date.toISOString(),
    unread: row.unread,
    hasAttachments: row.attachments.length > 0,
  };
}

export function messageView(row: MailMessage, rawKept: boolean): MailMessageView {
  return {
    ...messageSummary(row),
    cc: row.ccAddresses,
    messageIdHeader: row.messageIdHeader,
    inReplyTo: row.inReplyTo,
    text: row.bodyText,
    html: row.bodyHtml,
    attachments: row.attachments.map((a, index) => ({ index, ...a })),
    rawKept,
    error: row.error,
  };
}

export { MailHostError, MailInputError };
