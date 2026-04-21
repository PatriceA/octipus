import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { coreLogger } from '@/utils/logger';

const ASSISTANT_DIR = join(homedir(), '.assistant');
const TOKEN_FILE = join(ASSISTANT_DIR, 'local-token');
const TOKEN_BYTES = 32;

/**
 * Ensure the local auth token file exists.
 * Creates ~/.assistant/local-token with a random 32-byte hex token on first call.
 * File is chmod 600 (user-only read/write).
 */
export function ensureLocalToken(): string {
  if (!existsSync(ASSISTANT_DIR)) {
    mkdirSync(ASSISTANT_DIR, { recursive: true });
  }

  if (existsSync(TOKEN_FILE)) {
    return readFileSync(TOKEN_FILE, 'utf-8').trim();
  }

  const token = randomBytes(TOKEN_BYTES).toString('hex');
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  coreLogger.info('Generated local auth token at ~/.assistant/local-token');
  return token;
}

/**
 * Read the current local token. Returns null if not yet generated.
 */
export function readLocalToken(): string | null {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    return readFileSync(TOKEN_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Validate a local auth token using timing-safe comparison.
 * Also validates that the connection comes from localhost.
 */
export function validateLocalAuth(token: string, remoteIp: string): { valid: boolean; reason?: string } {
  // Only allow from localhost
  const localhostIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'];
  if (!localhostIps.includes(remoteIp)) {
    return { valid: false, reason: 'Local auth only allowed from localhost' };
  }

  const storedToken = readLocalToken();
  if (!storedToken) {
    return { valid: false, reason: 'No local token configured' };
  }

  // Timing-safe comparison to prevent timing attacks
  const tokenBuf = Buffer.from(token, 'utf-8');
  const storedBuf = Buffer.from(storedToken, 'utf-8');

  if (tokenBuf.length !== storedBuf.length) {
    return { valid: false, reason: 'Invalid local token' };
  }

  if (!timingSafeEqual(tokenBuf, storedBuf)) {
    return { valid: false, reason: 'Invalid local token' };
  }

  return { valid: true };
}

/**
 * Regenerate the local token. Useful if compromised.
 */
export function regenerateLocalToken(): string {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  if (!existsSync(ASSISTANT_DIR)) {
    mkdirSync(ASSISTANT_DIR, { recursive: true });
  }
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  coreLogger.info('Regenerated local auth token');
  return token;
}
