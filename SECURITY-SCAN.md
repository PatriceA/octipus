# Security Scan Report

**Date:** 2026-03-06
**Repository:** the_assistant
**Scan Type:** Manual static analysis

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 4     |
| HIGH     | 10    |
| MEDIUM   | 15    |
| LOW      | 13    |

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

### C4: Command Injection in Docker Tool (All Operations)
- **File:** `src/tools/docker/index.ts:117, 145, 152, 161-165, 176-178, 188`
- **Issue:** The `runDocker()` method concatenates user input directly into shell commands via `execAsync(`docker ${cmd}`)`. All Docker operations (start, stop, logs, build, exec) pass user-controlled parameters (`container`, `tag`, `dockerfile`, `path`, `command`) unsanitized into shell execution. A container name like `foo; rm -rf /` achieves arbitrary command execution.
- **Fix:** Replace `execAsync(`docker ${cmd}`)` with `spawn('docker', [...argsArray])` using array-based arguments, matching the safe pattern already used by git/github/gitlab tools.

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

### H5: Python Code Injection in Wake Word Engine
- **File:** `src/voice/wake-word.ts:49-99, 237-277`
- **Issue:** `modelPath` and `accessKey` are interpolated directly into Python script strings executed via `python3 -c`. Malicious values like `"; import os; os.system("cmd")` break out of the string context and achieve arbitrary Python code execution.
- **Fix:** Write parameters as JSON to a temp file and have the Python script read from it, or use proper escaping.

### H6: Python Code Injection in STT Engine
- **File:** `src/voice/stt.ts:241-265`
- **Issue:** `this.model` and `audioPath` are interpolated directly into a Python script string. If either contains Python string-breaking characters, arbitrary code execution is possible.
- **Fix:** Same as H5 -- pass parameters via JSON file or environment variables instead of string interpolation.

### H7: SSRF via Websearch `fetch_page` Tool
- **File:** `src/tools/websearch/index.ts:271-280`
- **Issue:** The `fetch_page` tool navigates a Playwright browser to an arbitrary user-supplied URL with no validation. An attacker (or manipulated LLM) can request internal URLs such as `http://169.254.169.254/latest/meta-data/` (cloud metadata), `http://localhost:5432`, or `file:///etc/passwd`.
- **Fix:** Validate URL schemes (https/http only), resolve DNS and reject private/reserved IP ranges (RFC 1918, link-local, loopback), block redirects to private ranges.

### H8: SSRF via Browser Tool `open`/`navigate`
- **File:** `src/tools/browser/index.ts:44-46, 67-69`
- **Issue:** Same as H7. The browser tool navigates to arbitrary user-supplied URLs with no scheme or host validation.
- **Fix:** Same as H7.

### H9: SSRF via Outbound Webhook URLs
- **File:** `src/hooks/actions.ts:120-142`
- **Issue:** The `executeWebhook` action fetches a URL from user-configurable hook configuration stored in the database. No validation that the URL points to an external host. An attacker who can create hooks can issue requests to internal services.
- **Fix:** Validate webhook URLs against a denylist of private/internal IP ranges and schemes.

### H10: Webhook Receiver Has No Signature Verification
- **File:** `src/api/routes/webhooks.ts:12-61`
- **Issue:** The webhook endpoint at `/api/webhooks/:path` is completely unauthenticated (confirmed at `src/api/server.ts:140-141`). No HMAC signature verification. Any external party who discovers a webhook path can trigger hook execution, potentially spawning agents, executing tools, or chaining with H9 for SSRF.
- **Fix:** Implement webhook secret verification per registered hook (e.g., `X-Hub-Signature-256` for GitHub).

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

### M9: Shell Tool Blocklist Validation is Bypassable
- **File:** `src/tools/shell/index.ts:10-18, 155-179`
- **Issue:** `validateCommand()` uses a blocklist that only catches exact strings like `rm -rf /`. It does not protect against `curl`/`wget`/`nc` for data exfiltration, obfuscated commands, or environment variable tricks. The `run` and `run_background` tools pass commands directly to `sh -c`.
- **Fix:** Replace blocklist with allowlist, or use proper sandboxing (container, seccomp).

### M10: MCP Server HTTP Transport -- Wildcard CORS, No Authentication
- **File:** `mcp-server/src/index.ts:47-49`
- **Issue:** In HTTP mode, the MCP server sets `Access-Control-Allow-Origin: *` and has zero authentication on `/sse` and `/messages` endpoints. Anyone who can reach this port can control the assistant.
- **Fix:** Add authentication (API key or session token) and restrict CORS origins.

### M11: Webhook Receiver Leaks Execution Details
- **File:** `src/api/routes/webhooks.ts:49-55`
- **Issue:** Response body reveals hook count, execution count, and failure count to unauthenticated callers. Information disclosure enables attackers to confirm successful exploitation.
- **Fix:** Return minimal response (e.g., `{ received: true }`) or require authentication.

### M12: Error Handler Leaks Validation Details
- **File:** `src/api/server.ts:71-73`
- **Issue:** Validation errors return `error.message` directly to clients. Can expose schema details, expected types, and internal field names.
- **Fix:** Return generic validation error messages; log details server-side only.

### M13: Health Endpoints Expose Infrastructure Details
- **File:** `src/api/routes/health.ts:15-68`, `src/api/middleware/auth-guard.ts:3-8`
- **Issue:** All `/api/health/*` paths are public. `/api/health/detailed` exposes system uptime, agent count, database/Redis health with error messages, and LiteLLM status. Reveals internal infrastructure topology.
- **Fix:** Restrict detailed health endpoints to authenticated users or internal networks.

### M14: PII Filter Stores Original Values in Redaction Records
- **File:** `src/core/orchestrator/pii-filter.ts:69-74`
- **Issue:** The `filterPII` function returns a `redactions` array containing the `original` PII value. If logged, stored, or returned to a client, it defeats the purpose of PII filtering.
- **Fix:** Remove or hash the original value in redaction records; store only a truncated/masked version for debugging.

### M15: Login Endpoint Returns HTTP 200 on Failure
- **File:** `src/api/routes/auth.ts:20-31`
- **Issue:** Login failure returns `{ error: 'Invalid credentials' }` with implicit 200 status instead of 401. Registration returns `{ error: 'Username already exists' }` with 200 (line 143), enabling username enumeration.
- **Fix:** Return proper HTTP status codes (401 for auth failure, 409 for duplicate).

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

### L8: Backup Script Shell Injection Risk
- **File:** `scripts/backup.ts:37, 91`
- **Issue:** Database URL components (password, host, database name) and config file paths are interpolated into Bun shell commands. While Bun's `$` template provides some escaping, shell metacharacters in the database password or unusual file paths could cause issues.
- **Fix:** Use array-based spawn or validate/escape values explicitly.

### L9: MCP Server Health Endpoint Leaks Backend URL
- **File:** `mcp-server/src/index.ts:76-77`
- **Issue:** The `/health` endpoint exposes the internal `assistantUrl`, revealing network topology to unauthenticated callers.
- **Fix:** Remove `assistantUrl` from health response.

### L10: Secret-Injector Error Messages Reveal Secret Names
- **File:** `src/security/secret-injector.ts:56, 73, 93-94`
- **Issue:** When secret access is denied or not found, replacement strings like `[ACCESS_DENIED:${secretName}]` are inserted into content sent to LLMs or other consumers, leaking credential names to downstream systems.
- **Fix:** Use generic placeholders without the secret name.

### L11: Default HOST Binds to All Interfaces
- **File:** `.env.example:32`, `src/config/defaults.ts:36`
- **Issue:** Default API host `0.0.0.0` binds to all interfaces. Safe for containers but dangerous on bare-metal/VM where the API is exposed to the entire network without a reverse proxy.
- **Fix:** Default to `127.0.0.1`; document how to change for container deployments.

### L12: OAuth Token Exchange Error Leaks Provider Response
- **File:** `src/security/oauth.ts:218-221`
- **Issue:** When token exchange fails, the raw provider error response is logged and thrown, potentially leaking sensitive details from the OAuth provider.
- **Fix:** Log the raw error server-side; throw a generic error message.

### L13: No Session Count Limit Per User
- **File:** `src/security/auth/session.ts`
- **Issue:** `create()` has no limit on concurrent sessions per user. `countForUser()` exists but is never called. An attacker with compromised credentials can create unlimited sessions.
- **Fix:** Enforce a maximum session count per user using the existing `countForUser()` method.

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
- **Shell command validation** blocks some dangerous commands for the main execute tool (though bypassable -- see M9)
- **Git/GitHub/GitLab tools** correctly use `spawn()` with array-based arguments, avoiding shell interpretation
- **No `eval()` usage** found anywhere in the codebase
- **No `.env` files committed** -- `.gitignore` properly configured
- **React auto-escaping** -- no `dangerouslySetInnerHTML` found in the web frontend
- **No TLS/SSL verification disabling** found anywhere
- **No open redirect vulnerabilities** identified
- **WebSocket endpoints** properly authenticate via session tokens
- **Structured pino logging** used throughout instead of `console.log`

---

## Recommendations (Priority Order)

1. **Immediate:** Fix C4 (Docker command injection) and C1 (timing attack) -- highest exploitability
2. **Immediate:** Fix C2/C3 (insecure RNG) -- simple one-line fixes
3. **Short-term:** Fix H4-H6 (shell/Python injection), implement rate limiting (H1), account lockout (H2)
4. **Short-term:** Fix SSRF issues H7-H9 (add URL validation for browser/websearch/webhooks)
5. **Short-term:** Add webhook signature verification (H10), fix vault KDF (H3)
6. **Short-term:** Fix symlink bypass (M1), workspace path validation (M2), MCP server auth (M10), shell blocklist (M9)
7. **Medium-term:** Add security headers (L1), CORS hardening (M6), session cookies (M8), proper HTTP status codes (M15)
8. **Medium-term:** Address ReDoS (L3), password policy (L6), env leaks (L5), PII filter leak (M14)
9. **Long-term:** Restrict health endpoints (M13), fix info disclosure (M11, M12, L9-L12), add session limits (L13)
