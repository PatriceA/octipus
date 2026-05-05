/**
 * MCP token bootstrap.
 *
 * When multi-user is enabled, the MASTER_KEY Bearer fallback is
 * suppressed — every request must carry a real session or api token.
 * That breaks the bundled MCP server (and the `.mcp.json` files we
 * stamp out for Claude Code / Codex / Gemini CLI), which authenticate
 * via the `OCTIPUS_API_KEY` env var.
 *
 * On startup we mint (or re-use) a personal api token owned by the
 * bootstrap admin user — name `mcp-bootstrap`, scope `[]` (= all
 * scopes), no expiry — and write the plaintext to
 * `~/.octipus/mcp-token` (mode 600). `bin/octi` reads that file when
 * regenerating `.mcp.json` so MCP clients keep working without ever
 * touching the master key.
 *
 * Idempotent: a second startup notices the file + matching DB row and
 * exits silently. Token rotation is `rm ~/.octipus/mcp-token` then
 * restart — the next boot revokes the orphaned DB row and mints a
 * fresh one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { apiTokens } from '@/db/schema/api-tokens';
import { users } from '@/db/schema/users';
import { getApiTokenManager, hashToken, looksLikeApiToken } from '@/security/api-tokens';
import { logger } from '@/utils/logger';

const TOKEN_PATH = join(homedir(), '.octipus', 'mcp-token');
const TOKEN_NAME = 'mcp-bootstrap';

export async function ensureMcpBootstrapToken(): Promise<void> {
  const db = getDb();

  const [admin] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(and(eq(users.isAdmin, true), eq(users.isActive, true)))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!admin) {
    logger.warn(
      'multi-user is on but no active admin user exists — skipping MCP token bootstrap. Register an admin via the web UI then restart.',
    );
    return;
  }

  const onDisk = readTokenFile();
  if (onDisk) {
    const [row] = await db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, hashToken(onDisk)), eq(apiTokens.userId, admin.id)))
      .limit(1);
    if (row && !row.revokedAt) {
      // Existing token still valid; no action.
      return;
    }
  }

  // Revoke any stale `mcp-bootstrap` rows for this admin so the table
  // doesn't accumulate dead siblings across rotations.
  await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.userId, admin.id), eq(apiTokens.name, TOKEN_NAME)));

  const issued = await getApiTokenManager().issue(admin.id, {
    name: TOKEN_NAME,
    scopes: [],
    metadata: { purpose: 'mcp-bootstrap', autoIssued: true },
  });
  writeTokenFile(issued.plaintext);
  logger.info(
    { tokenPath: TOKEN_PATH, adminUsername: admin.username },
    'Minted MCP bootstrap api token. bin/octi will pick it up on next .mcp.json regen.',
  );
}

function readTokenFile(): string | null {
  try {
    if (!existsSync(TOKEN_PATH)) return null;
    const raw = readFileSync(TOKEN_PATH, 'utf8').trim();
    return looksLikeApiToken(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeTokenFile(token: string): void {
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, `${token}\n`, { encoding: 'utf8' });
  try { chmodSync(TOKEN_PATH, 0o600); } catch { /* best effort on non-POSIX */ }
}

/** Test aid: location of the on-disk token. */
export function getMcpTokenPath(): string { return TOKEN_PATH; }
