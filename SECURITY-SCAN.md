# Security Scan Report

**Date:** 2026-03-06
**Repository:** the_assistant
**Scan Type:** Manual static analysis

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3     |
| HIGH     | 4     |
| MEDIUM   | 8     |
| LOW      | 7     |

---

## CRITICAL Findings

### C1: Timing Attack on MASTER_KEY Comparison
- **File:** `src/api/server.ts:96`
- **Issue:** The MASTER_KEY bearer token is compared using `===`, which is vulnerable to timing attacks. An attacker can progressively guess the key byte-by-byte by measuring response times.
- **Fix:** Use the existing `secureCompare()` function from `src/utils/crypto.ts:143`.

### C2: Insecure RNG for TOTP Backup Codes
- **File:** `src/security/auth/totp.ts:58, 218`
- **Issue:** `Math.random()` is used to generate TOTP backup codes. `Math.random()` is not cryptographically secure. Backup codes serve as authentication bypass tokens and must be unpredictable.
- **Fix:** Replace with `crypto.randomBytes()` or `crypto.getRandomValues()`.

### C3: Insecure RNG for Channel Linking Codes
- **File:** `src/channels/linking.ts:80`
- **Issue:** `Math.random()` generates 6-character linking codes that bind channel identities (Telegram, Slack, Teams) to user accounts. The small keyspace (~729M) combined with predictable PRNG makes brute-force or prediction feasible.
- **Fix:** Use `crypto.randomBytes()` for code generation.

---

## HIGH Findings

### H1: No Rate Limiting on Authentication Endpoints
- **File:** `src/api/routes/auth.ts`
- **Issue:** `/api/auth/login`, `/api/auth/register`, `/api/auth/passkey/auth/verify`, and `/api/auth/link` have no rate limiting. The rate_limit permission condition is stubbed out (`src/security/permissions.ts:168-170`). Enables credential stuffing, brute-force, and linking code guessing.
- **Fix:** Implement rate limiting middleware (e.g., sliding window per IP/user with Redis).

### H2: No Account Lockout Mechanism
- **File:** `src/api/routes/auth.ts:14-72`
- **Issue:** No failed login attempt counter or lockout logic exists. Login simply returns `{ error: 'Invalid credentials' }` with no tracking.
- **Fix:** Track failed attempts per user/IP; lock accounts after N failures with exponential backoff.

### H3: Vault Master Key Has No KDF Stretching
- **File:** `src/security/vault.ts:24`
- **Issue:** The vault master key is derived via a single SHA-256 hash with no salt and no iterations. Argon2id `deriveKey()` exists in `crypto.ts` but is not used here. Low-entropy master keys are trivially brute-forceable.
- **Fix:** Use Argon2id or PBKDF2 with a fixed salt for deterministic derivation with proper stretching.

### H4: Command Injection via `which` Tool
- **File:** `src/tools/shell/index.ts:125`
- **Issue:** The `which` tool passes user input directly into a shell command via string interpolation: `` `which ${args.name}` ``. This bypasses `validateCommand()`. Input like `foo; cat /etc/passwd` executes the injected command. The tool has `requiresPermission: false`, so no approval is requested.
- **Fix:** Validate `args.name` to alphanumeric/hyphens/underscores only, or use `execFile('which', [args.name])` to avoid shell interpretation.

---

## MEDIUM Findings

### M1: Symlink Bypass in Filesystem Path Validation
- **File:** `src/tools/filesystem/index.ts:295-303`
- **Issue:** `validatePath()` uses `resolve()` + `startsWith()` but does not resolve symlinks with `fs.realpathSync()`. A symlink inside the workspace pointing to `/etc/passwd` would pass validation.
- **Fix:** Call `fs.realpathSync()` before the `startsWith()` check.

### M2: Workspace Path Manipulation via API
- **File:** `src/api/routes/workspace.ts:21-43`
- **Issue:** `PUT /api/workspace` allows adding arbitrary directories (including `/`, `/etc`) to `additionalPaths`. This bypasses the filesystem tool's path validation since it checks against all configured paths.
- **Fix:** Restrict to subdirectories of workspace root, or add a denylist for system directories.

### M3: `/tmp` Unconditionally Allowed in Path Validation
- **File:** `src/tools/filesystem/index.ts:300`
- **Issue:** Any path under `/tmp` is always allowed. This shared directory could be used to read/write files from other processes or as a staging area for attacks.
- **Fix:** Restrict to a namespaced subdirectory (e.g., `/tmp/the_assistant-<session-id>/`).

### M4: Hardcoded Database Credential Fallbacks
- **Files:** `drizzle.config.ts:8`, `src/db/migrate.ts:16`
- **Issue:** Fallback connection string `postgresql://assistant:assistant@localhost:5432/assistant` is used when `DATABASE_URL` is not set. In production, a missing env var silently uses a known credential.
- **Fix:** Remove fallbacks; throw an error if `DATABASE_URL` is not configured.

### M5: Hardcoded LiteLLM API Key Fallback
- **File:** `src/api/routes/models.ts:189`
- **Issue:** Fallback key `'sk-litellm-master-key'` is used when no key is configured. This is a predictable default.
- **Fix:** Require explicit configuration; fail if no key is set.

### M6: CORS Supports Wildcard Origins
- **File:** `src/api/server.ts:59`
- **Issue:** When `corsOrigins` includes `'*'`, CORS is set to `origin: true` (reflect any origin) with `credentials: true`. This allows any website to make authenticated requests to the API.
- **Fix:** Never allow wildcard with credentials. Require explicit origin allowlist in production.

### M7: Passkey Challenges Stored In-Memory Only
- **File:** `src/security/auth/passkey.ts:21`
- **Issue:** WebAuthn challenges are stored in a `Map<>` in process memory. In multi-instance deployments, challenge replay across instances is possible.
- **Fix:** Store challenges in Redis with TTL as the code comments suggest.

### M8: Session Tokens Returned in Response Body
- **File:** `src/api/routes/auth.ts:55-63`
- **Issue:** Session tokens are returned as JSON rather than HttpOnly/Secure/SameSite cookies. Tokens stored in `localStorage` are vulnerable to XSS-based theft.
- **Fix:** Set session tokens as HttpOnly, Secure, SameSite=Strict cookies.

---

## LOW Findings

### L1: Missing Security Headers
- **File:** `src/api/server.ts`
- **Issue:** No `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, or `Strict-Transport-Security` headers are set.
- **Fix:** Add security headers middleware.

### L2: `secureCompare` Leaks Length Information
- **File:** `src/utils/crypto.ts:143-154`
- **Issue:** Early return on length mismatch leaks whether string lengths match, partially defeating the constant-time comparison.
- **Fix:** Use `crypto.timingSafeEqual()` with padded buffers.

### L3: ReDoS via User-Supplied Regex
- **Files:** `src/tools/filesystem/index.ts:260`, `src/security/permissions.ts:132-143`, `src/hooks/triggers.ts:82,212`
- **Issue:** `new RegExp(args.pattern)` from user input without validation allows catastrophic backtracking patterns.
- **Fix:** Validate regex complexity, set timeouts, or use a safe regex library.

### L4: No Sanitization on WebSocket Messages
- **File:** `src/api/websocket.ts:130-135`
- **Issue:** User-supplied content from WebSocket messages flows directly into the pipeline without sanitization. While React auto-escapes on render, non-browser consumers (logs, email notifications) could be vulnerable.
- **Fix:** Sanitize or escape user content at the input boundary.

### L5: Env Tool Can Leak Sensitive Variables
- **File:** `src/tools/shell/index.ts:137-152`
- **Issue:** The `env` tool's keyword-based redaction (`PASSWORD`, `SECRET`, `KEY`, `TOKEN`, `CREDENTIAL`) is easily bypassed by non-standard variable names. It also has `requiresPermission: false`.
- **Fix:** Use an allowlist approach instead of a keyword denylist, or require permission.

### L6: Minimal Password Policy
- **File:** `src/api/routes/auth.ts:199`
- **Issue:** Only `minLength: 8` is enforced. No complexity requirements or check against breached passwords.
- **Fix:** Add complexity requirements and/or check against common password lists.

### L7: SQL Injection via Vector Search
- **File:** `src/db/schema/embeddings.ts:38,42`
- **Issue:** `JSON.stringify(vector)` is interpolated into SQL template literals for vector operations. While the input is expected to be a `number[]`, if an attacker can control the vector input, the `JSON.stringify` output could potentially break out of the intended SQL context.
- **Fix:** Use parameterized queries for vector values.

---

## Positive Observations

- **AES-256-GCM** used correctly with random 12-byte IVs and proper auth tag handling
- **Argon2id** with good parameters (64MB, 3 iterations, 4 parallelism) for password hashing
- **Session tokens are hashed** (SHA-256) before Redis storage
- **OAuth uses PKCE** with S256 code challenge and server-side state validation with TTL
- **OAuth state is single-use** (deleted after consumption)
- **No JWT used** -- opaque session tokens avoid algorithm confusion attacks
- **TOTP secrets encrypted at rest** with AES-256-GCM
- **Passkey implementation** properly updates counters and verifies origin/RP ID
- **Token generation** uses `crypto.randomBytes()` (except the noted backup code issue)
- **SQL queries** mostly use Drizzle ORM with parameterized queries
- **Shell command validation** blocks dangerous commands (rm -rf, etc.) for the main execute tool
- **No `.env` files committed** -- `.gitignore` properly configured
- **React auto-escaping** -- no `dangerouslySetInnerHTML` found in the web frontend

---

## Recommendations (Priority Order)

1. **Immediate:** Fix C1 (timing attack), C2/C3 (insecure RNG) -- these are simple fixes
2. **Short-term:** Implement rate limiting (H1), account lockout (H2), fix command injection (H4)
3. **Short-term:** Fix vault KDF (H3), symlink bypass (M1), workspace path validation (M2)
4. **Medium-term:** Add security headers (L1), CORS hardening (M6), session cookies (M8)
5. **Medium-term:** Address ReDoS (L3), password policy (L6), env leaks (L5)
