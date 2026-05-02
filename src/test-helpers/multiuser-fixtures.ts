/**
 * Test fixtures for the multi-user isolation suite.
 *
 * These helpers seed users/sessions/agents/documents/etc. via raw SQL
 * instead of the repository singletons. The reason: bun's
 * `mock.module` is a process-global module replacement, and at least
 * one other test file (`src/core/gateway/commands.test.ts`) replaces
 * `@/db/repositories/session-repository` with a partial stub. When
 * test files run in the same process, that stub leaks into the
 * isolation tests' `beforeAll` and `sessionRepository.create` is
 * undefined.
 *
 * Going through `executeRaw` keeps the seed step independent of any
 * upstream module-mock state — the schema is the contract.
 */
import { randomUUID } from 'node:crypto';

export interface SeedUser {
  id: string;
  username: string;
  isAdmin?: boolean;
}

export async function seedUsers(users: SeedUser[]): Promise<void> {
  const { executeRaw } = await import('@/db/postgres');
  if (users.length === 0) return;
  const values = users
    .map((u) => `('${u.id}', '${u.username}', ${u.isAdmin ? 'true' : 'false'})`)
    .join(', ');
  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES ${values} ON CONFLICT DO NOTHING`,
  );
}

export interface SeedSessionInput {
  userId: string;
  channelType?: string;
  channelId?: string;
  title?: string | null;
}

export async function seedSession(input: SeedSessionInput): Promise<{ id: string }> {
  const { executeRaw } = await import('@/db/postgres');
  const id = randomUUID();
  const channelType = input.channelType ?? 'webchat';
  const channelId = input.channelId ?? id.slice(0, 8);
  const title = input.title === undefined ? 'NULL' : input.title === null ? 'NULL' : `'${input.title.replace(/'/g, "''")}'`;
  await executeRaw(
    `INSERT INTO sessions (id, user_id, channel_type, channel_id, title)
     VALUES ('${id}', '${input.userId}', '${channelType}', '${channelId}', ${title})`,
  );
  return { id };
}

export interface SeedMessageInput {
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

export async function seedMessage(input: SeedMessageInput): Promise<{ id: string }> {
  const { executeRaw } = await import('@/db/postgres');
  const id = randomUUID();
  await executeRaw(
    `INSERT INTO messages (id, session_id, role, content)
     VALUES ('${id}', '${input.sessionId}', '${input.role}', '${input.content.replace(/'/g, "''")}')`,
  );
  return { id };
}

export interface SeedAgentInput {
  id: string;
  sessionId: string;
  userId: string;
  role?: string;
  model?: string;
  topic?: string;
  status?: string;
}

export async function seedAgent(input: SeedAgentInput): Promise<{ id: string }> {
  const { executeRaw } = await import('@/db/postgres');
  await executeRaw(
    `INSERT INTO agents (id, session_id, user_id, role, model, topic, status)
     VALUES ('${input.id}', '${input.sessionId}', '${input.userId}',
             '${input.role ?? 'general'}', '${input.model ?? 'test'}',
             '${input.topic ?? 'test'}', '${input.status ?? 'completed'}')`,
  );
  return { id: input.id };
}

export interface SeedDocumentInput {
  userId: string;
  originalName: string;
  storagePath?: string;
  status?: 'queued' | 'processing' | 'completed' | 'failed';
}

export async function seedDocument(input: SeedDocumentInput): Promise<{ id: string }> {
  const { executeRaw } = await import('@/db/postgres');
  const id = randomUUID();
  const filename = input.originalName.replace(/'/g, "''");
  await executeRaw(
    `INSERT INTO documents (id, user_id, filename, original_name, mime_type, size, storage_path, status)
     VALUES ('${id}', '${input.userId}', '${filename}', '${filename}',
             'application/octet-stream', 1, '${input.storagePath ?? '/tmp/no-such'}',
             '${input.status ?? 'queued'}')`,
  );
  return { id };
}

export interface SeedAgentEventInput {
  agentId: string;
  sessionId: string;
  type: string;
  data?: Record<string, unknown>;
}

export async function seedAgentEvent(input: SeedAgentEventInput): Promise<void> {
  const { executeRaw } = await import('@/db/postgres');
  const data = JSON.stringify(input.data ?? {}).replace(/'/g, "''");
  await executeRaw(
    `INSERT INTO agent_events (agent_id, session_id, type, data)
     VALUES ('${input.agentId}', '${input.sessionId}', '${input.type}', '${data}'::jsonb)`,
  );
}
