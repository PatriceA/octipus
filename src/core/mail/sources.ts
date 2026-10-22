/**
 * Where received mail comes from: an IMAP folder or a POP3 drop, reached
 * through the account's pinned host (hosts.ts). A source hands over what is
 * new since the account's sync state, a bounded batch at a time, and the
 * state to continue from. Nothing is changed or deleted on the server.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { MailAccount, MailSyncState } from '@/db/schema/mail';
import type { MailServer } from '@/shared/mail';
import { type PinnedHost, pinMailHost } from './hosts';
import { Pop3Client } from './pop3';

/** Messages above this size are stored without their raw source (headers and a note only). */
export const MAX_RAW_BYTES = 25 * 1024 * 1024;
/** The newest messages a first sync takes from the window. */
export const FIRST_SYNC_MAX = 200;
const TIMEOUT_MS = 30_000;

export interface FetchedMessage {
  /** IMAP `<uidvalidity>:<uid>`, POP3 the UIDL. */
  remoteId: string;
  /** The whole message, or its headers only when it is over `MAX_RAW_BYTES`. */
  source: Buffer;
  /** `source` is the headers only. */
  truncated: boolean;
  size: number;
  unread: boolean;
  /** When the server received it (IMAP INTERNALDATE). */
  receivedAt?: Date;
}

export interface FetchBatch {
  messages: FetchedMessage[];
  state: MailSyncState;
  /** More is waiting beyond this batch. */
  more: boolean;
}

export interface FetchOptions {
  /** A first sync takes nothing older than this. */
  since: Date;
  /** At most this many messages per batch. */
  limit: number;
  /** Which of these remote ids are already stored. */
  known: (remoteIds: string[]) => Promise<Set<string>>;
}

export interface MailSource {
  fetchNew(state: MailSyncState, opts: FetchOptions): Promise<FetchBatch>;
  close(): Promise<void>;
}

export type SourceAccount = Pick<MailAccount, 'protocol' | 'folder' | 'incoming' | 'localNetwork'>;

/** Open a connection to the account's incoming server and log in. */
export async function openSource(account: SourceAccount, password: string): Promise<MailSource> {
  const server = account.incoming;
  const pinned = await pinMailHost(server.host, server.security, account.localNetwork);
  return account.protocol === 'pop3' ? openPop3(server, pinned, password) : openImap(account.folder, server, pinned, password);
}

/** Log in to the incoming server and leave: a settings check. */
export async function checkIncoming(account: SourceAccount, password: string): Promise<void> {
  const source = await openSource(account, password);
  await source.close();
}

// ── IMAP ────────────────────────────────────────────────────────────

function imapClient(server: MailServer, pinned: PinnedHost, password: string): ImapFlow {
  return new ImapFlow({
    host: pinned.address,
    port: server.port,
    secure: server.security === 'tls',
    // STARTTLS is required, never optional: a server that does not offer it fails.
    doSTARTTLS: server.security === 'starttls' ? true : server.security === 'none' ? false : undefined,
    servername: pinned.servername,
    tls: pinned.servername ? { servername: pinned.servername } : undefined,
    auth: { user: server.username, pass: password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 4,
    maxLiteralSize: MAX_RAW_BYTES + 1024 * 1024,
  });
}

async function openImap(folder: string, server: MailServer, pinned: PinnedHost, password: string): Promise<MailSource> {
  const client = imapClient(server, pinned, password);
  client.on('error', () => undefined); // surfaced through the failing command
  await client.connect();
  return {
    async fetchNew(state, opts) {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new Error(`The folder ${folder} could not be opened`);
        const uidValidity = String(mailbox.uidValidity);
        let lastUid = state.uidValidity === uidValidity && typeof state.lastUid === 'number' ? state.lastUid : null;
        if (lastUid === null) {
          // A first sync (or the folder was rebuilt): the newest messages of the window.
          const found = ((await client.search({ since: opts.since }, { uid: true })) || []).sort((a, b) => a - b);
          const candidates = found.slice(-FIRST_SYNC_MAX);
          lastUid = candidates.length > 0 ? candidates[0] - 1 : Math.max(0, Number(mailbox.uidNext) - 1);
        }
        const from = lastUid;
        const uids = ((await client.search({ uid: `${from + 1}:*` }, { uid: true })) || [])
          .filter((u) => u > from)
          .sort((a, b) => a - b);
        const batch = uids.slice(0, opts.limit);
        const meta: Array<{ uid: number; size: number; unread: boolean; receivedAt?: Date }> = [];
        if (batch.length > 0) {
          for await (const m of client.fetch(batch.join(','), { uid: true, flags: true, size: true, internalDate: true }, { uid: true })) {
            const internal = m.internalDate ? new Date(m.internalDate) : undefined;
            meta.push({ uid: m.uid, size: m.size ?? 0, unread: !m.flags?.has('\\Seen'), receivedAt: internal && Number.isFinite(internal.getTime()) ? internal : undefined });
          }
        }
        const messages: FetchedMessage[] = [];
        for (const m of meta.sort((a, b) => a.uid - b.uid)) {
          const truncated = m.size > MAX_RAW_BYTES;
          const one = await client.fetchOne(String(m.uid), truncated ? { uid: true, headers: true } : { uid: true, source: true }, { uid: true });
          const source = one ? (truncated ? one.headers : one.source) : undefined;
          if (!source) continue;
          messages.push({ remoteId: `${uidValidity}:${m.uid}`, source: Buffer.from(source), truncated, size: m.size, unread: m.unread, receivedAt: m.receivedAt });
        }
        const next = batch.length > 0 ? batch[batch.length - 1] : from;
        return { messages, state: { uidValidity, lastUid: next }, more: uids.length > batch.length };
      } finally {
        lock.release();
      }
    },
    async close() {
      await client.logout().catch(() => client.close());
    },
  };
}

// ── POP3 ────────────────────────────────────────────────────────────

/** The Date header of a message's headers, or null. */
async function headerDate(headers: Buffer): Promise<Date | null> {
  const parsed = await simpleParser(headers, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true });
  return parsed.date && Number.isFinite(parsed.date.getTime()) ? parsed.date : null;
}

async function openPop3(server: MailServer, pinned: PinnedHost, password: string): Promise<MailSource> {
  const client = await Pop3Client.connect({
    address: pinned.address,
    port: server.port,
    servername: pinned.servername,
    security: server.security,
    username: server.username,
    password,
    timeoutMs: TIMEOUT_MS,
    maxResponseBytes: MAX_RAW_BYTES + 1024 * 1024,
  });
  return {
    async fetchNew(state, opts) {
      const listed = (await client.uidl()).sort((a, b) => a.num - b.num);
      const sizes = await client.list();
      const onServer = new Set(listed.map((m) => m.uid));
      // What earlier syncs passed over, still on the server.
      const skipped = new Set((state.skipped ?? []).filter((uid) => onServer.has(uid)));
      if (state.skipped === undefined) {
        // A first sync: only the newest messages of the window; the rest is passed over for good.
        const candidates = listed.slice(-FIRST_SYNC_MAX);
        for (const m of listed.slice(0, listed.length - candidates.length)) skipped.add(m.uid);
        for (const m of candidates) {
          const date = await headerDate(await client.top(m.num, 0));
          if (date && date < opts.since) skipped.add(m.uid);
        }
      }
      const known = await opts.known(listed.map((m) => m.uid).filter((uid) => !skipped.has(uid)));
      const pending = listed.filter((m) => !skipped.has(m.uid) && !known.has(m.uid));
      const messages: FetchedMessage[] = [];
      for (const m of pending.slice(0, opts.limit)) {
        const size = sizes.get(m.num) ?? 0;
        const truncated = size > MAX_RAW_BYTES;
        const source = truncated ? await client.top(m.num, 0) : await client.retr(m.num);
        messages.push({ remoteId: m.uid, source, truncated, size: size || source.length, unread: true });
      }
      return { messages, state: { skipped: [...skipped] }, more: pending.length > opts.limit };
    },
    async close() {
      await client.quit();
    },
  };
}
