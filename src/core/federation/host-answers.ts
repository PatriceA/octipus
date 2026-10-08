/**
 * What a host install may answer the visitor's requests with
 * (docs/plans/federation-spec.md §7.3, §8.2), checked on the visitor (B)
 * before anything of it is used, stored or handed to a browser.
 *
 * The host is another install: its answers are untrusted input. Every id
 * this install puts in a URL, a frame or a query is a UUID; every string is
 * bounded; every list is capped. Objects keep fields this install does not
 * read (`passthrough`): a newer host may add some. An answer that does not
 * parse is refused as a whole (`bad_answer`, 502), never patched up.
 */
import { z } from 'zod';
import type { FederationRequestType } from './protocol';

const uuid = z.string().uuid();
const when = z.string().min(1).max(64);
const text = (max: number) => z.string().max(max);
const spaceRole = z.enum(['owner', 'editor', 'commenter', 'viewer', 'guest']);
const memberRole = z.enum(['editor', 'commenter', 'viewer', 'guest']);

export const hostRoomSchema = z.object({
  id: uuid,
  title: text(200),
  visibility: text(32).optional(),
  createdBy: text(200).nullable().optional(),
  unreadCount: z.number().int().min(0).optional(),
  muted: z.boolean().optional(),
}).passthrough();

export const hostRoomMessageSchema = z.object({
  id: uuid,
  roomId: uuid.optional(),
  role: text(32),
  content: text(200_000),
  authorUserId: text(200).nullable().optional(),
  authorName: text(200).nullable().optional(),
  agentId: text(200).nullable().optional(),
  createdAt: when,
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const taskSchema = z.object({
  id: uuid,
  title: text(500),
  status: text(32),
  notes: text(10_000).nullable().optional(),
}).passthrough();

const fileEntrySchema = z.object({
  name: z.string().min(1).max(1024).refine((n) => !n.includes('/') && !n.includes('\0') && n !== '.' && n !== '..', { message: 'not a file name' }),
  type: z.enum(['file', 'dir']),
  size: z.number().min(0),
}).passthrough();

/** The answer schema of each request type B sends. */
export const hostAnswerSchemas = {
  'ping': z.object({}).passthrough(),
  'space.join': z.object({
    space: z.object({ id: uuid, name: z.string().min(1).max(500), role: memberRole, scope: z.unknown() }).passthrough(),
    member: z.object({ handle: z.string().min(1).max(200) }).passthrough(),
  }).passthrough(),
  'space.leave': z.object({ warning: text(1000).optional() }).passthrough(),
  'space.info': z.object({ id: uuid.optional(), name: z.string().min(1).max(500), role: memberRole }).passthrough(),
  'space.members': z.object({
    members: z.array(z.object({
      userId: uuid,
      displayName: text(200),
      role: spaceRole,
      remote: z.boolean(),
      instanceId: text(64).nullable().optional(),
    }).passthrough()).max(10_000),
  }).passthrough(),
  'space.rooms': z.object({ rooms: z.array(hostRoomSchema).max(2_000) }).passthrough(),
  'room.page': z.object({ messages: z.array(hostRoomMessageSchema).max(200), hasMore: z.boolean() }).passthrough(),
  'note.list': z.object({
    notes: z.array(z.object({ id: uuid, title: text(500), slug: text(500), updatedAt: when }).passthrough()).max(5_000),
  }).passthrough(),
  'note.read': z.object({
    id: uuid, title: text(500), slug: text(500), body: text(2_000_000), bodySha256: z.string().regex(/^[0-9a-f]{64}$/), updatedAt: when,
  }).passthrough(),
  'note.propose': z.object({ proposal: z.object({ id: uuid, noteId: uuid, status: text(32), updatedAt: when }).passthrough() }).passthrough(),
  'task.list': z.object({ tasks: z.array(taskSchema).max(5_000) }).passthrough(),
  'task.read': z.object({
    task: taskSchema,
    comments: z.array(z.object({ id: uuid, body: text(10_000) }).passthrough()).max(1_000),
    truncated: z.boolean().optional(),
  }).passthrough(),
  'task.create': z.object({ task: taskSchema }).passthrough(),
  'task.checkout': z.object({ task: taskSchema }).passthrough(),
  'task.release': z.object({ task: taskSchema }).passthrough(),
  'task.comment': z.object({ comment: z.object({ id: uuid, body: text(10_000) }).passthrough() }).passthrough(),
  'file.list': z.object({ path: text(4096), entries: z.array(fileEntrySchema).max(10_000) }).passthrough(),
  'file.read': z.object({
    path: text(4096), size: z.number().min(0), encoding: z.enum(['utf8', 'base64']), content: text(3_000_000),
  }).passthrough(),
  'memory.list': z.object({
    entries: z.array(z.object({ id: uuid, body: text(20_000), authorKind: text(32), createdAt: when }).passthrough()).max(5_000),
  }).passthrough(),
  'gateway.frame': z.object({}).passthrough(),
  'conn.close': z.object({ closed: z.boolean().optional() }).passthrough(),
} satisfies Record<FederationRequestType, z.ZodType>;

export type HostAnswer<T extends FederationRequestType> = z.infer<(typeof hostAnswerSchemas)[T]>;

/** `raw`, the host's answer to `type`, parsed; throws the `ZodError` when it does not fit. */
export function parseHostAnswer<T extends FederationRequestType>(type: T, raw: unknown): HostAnswer<T> {
  return hostAnswerSchemas[type].parse(raw) as HostAnswer<T>;
}
