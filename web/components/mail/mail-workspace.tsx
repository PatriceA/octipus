'use client';

import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useModuleOn } from '@/lib/modules';
import { useWorkspace, useWorkspaceId } from '@/lib/workspace-context';
import { api } from '@/lib/api';
import type { MailAccountView } from '../../../src/shared/mail';
import { MailboxManager, mailAccountsKey, mailButton, mailInput } from './mailbox-manager';
import { MailboxInbox } from './mailbox-inbox';

export function MailWorkspace({ oauthInbox }: { oauthInbox?: ReactNode }) {
  const workspace = useWorkspaceId();
  const { activeWorkspace, isLoading } = useWorkspace();
  if (isLoading) return <p>Loading workspace…</p>;
  if (activeWorkspace?.kind === 'remote') return <p>Mailboxes on another install are not available here. Select a local workspace to read mail.</p>;
  return <MailWorkspaceScope key={workspace ?? 'personal'} oauthInbox={oauthInbox} />;
}
function MailWorkspaceScope({ oauthInbox }: { oauthInbox?: ReactNode }) {
  const workspace = useWorkspaceId();
  const mailOn = useModuleOn('mail');
  const accounts = useQuery({ queryKey: mailAccountsKey(workspace), enabled: mailOn, queryFn: () => api.get<MailAccountView[]>('/mail/accounts') });
  const [selection, setSelection] = useState(oauthInbox ? 'oauth' : '');
  const [manage, setManage] = useState(false);
  const selected = accounts.data?.find(account => account.id === selection) ?? (!oauthInbox ? accounts.data?.[0] : undefined);
  if (!mailOn) return oauthInbox ?? <p>Enable Mail in Settings → Modules to connect mailboxes.</p>;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-end gap-3"><label className="max-w-lg flex-1">Mailbox<select aria-label="Mailbox" className={mailInput} value={selected?.id ?? (oauthInbox ? 'oauth' : '')} onChange={e => setSelection(e.target.value)}>
      {oauthInbox && <option value="oauth">Google Workspace / Microsoft 365</option>}
      {!oauthInbox && !accounts.data?.length && <option value="">No mailbox connected</option>}
      {accounts.data?.map(account => <option key={account.id} value={account.id}>{account.label} — {account.address}</option>)}
    </select></label><button className={mailButton} onClick={() => setManage(!manage)}>{manage ? 'Close mailbox settings' : 'Manage mailboxes'}</button></div>
    {accounts.isLoading && <p>Loading mailboxes…</p>}{accounts.error && <p role="alert" className="text-error">{accounts.error.message}</p>}
    {(manage || (!oauthInbox && accounts.data?.length === 0)) && <MailboxManager />}
    {selected ? <MailboxInbox key={selected.id} account={selected} /> : oauthInbox}
  </div>;
}
