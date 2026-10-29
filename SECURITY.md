# Security Policy

## Supported Versions

Octipus is under active development. Security fixes target the `main` branch only. Tagged releases older than the latest two are **not** patched. Run `main` or the most recent tag.

## Reporting a Vulnerability

**Do not file security issues as public GitHub issues.**

Open a **GitHub Security Advisory** at the repo's
**Security → Advisories → New draft advisory**.

If GitHub Advisories are unavailable to you, contact the maintainer privately
through an existing trusted channel. Do not include exploit details in a public
issue or discussion.

### What to include

- Affected component (backend, web UI, MCP server, a specific channel, etc.) and version / commit
- Steps to reproduce (minimal proof-of-concept if possible)
- Impact assessment (what can an attacker do, under what preconditions)
- Suggested fix, if any

### What to expect

| When | What |
|---|---|
| Within 72 hours | We aim to acknowledge that the report landed |
| Within 7 days | We aim to provide an initial triage: severity, scope, and next steps |
| After triage | Timing depends on severity, complexity, and coordinated-disclosure needs |
| On release | Credit in the advisory and release notes (unless you prefer anonymity) |

## Scope

**In scope:**
- Auth bypass (JWT, WebAuthn, TOTP, session tokens)
- Permission escalation (role, trust level, tool allowlist)
- Prompt injection leading to unintended tool use or data exfiltration
- SSRF, command injection, path traversal, deserialization bugs
- Vault encryption / key handling
- Channel adapter signature verification (WhatsApp, Slack, Telegram, Teams)
- MCP server auth
- Audit log tampering or gaps

**Out of scope:**
- Issues requiring compromised developer machines / local filesystem access
- Self-XSS in the web UI with no privilege escalation
- Missing security headers on non-production endpoints
- Denial-of-service via unlimited LLM token spend (this is a configuration concern — use rate limits and cost caps)
- Vulnerabilities in third-party dependencies with no exploitable path through Octipus
- Social engineering of maintainers

## Safe Harbor

Good-faith security research is welcome. If you:

- Follow this disclosure policy
- Only test against your own instances (or a test account you set up)
- Avoid privacy violations, service disruption, or data destruction
- Give us a reasonable window to fix before public disclosure (90 days is standard)

…we will not pursue legal action or law-enforcement involvement for your research.

## After Disclosure

Fixed advisories are published publicly with:

- Root cause and impact
- Fix commit(s)
- Reporter credit
- Workarounds, if any, for users who cannot upgrade immediately

Stay in touch via GitHub Watch → Releases to get notified.

## Non-goals

Octipus is distributed under the MIT license. It comes with **no warranty**. Running it in production is your call; running it against untrusted input without sandboxing is not recommended. See [LICENSE](./LICENSE).

## Credential execution boundary

Vault names are integration selectors, not a content template language.
General tools, shell environments, file content, work plans, notes, artifact
configs and remote MCP arguments reject vault interpolation before execution.
Generic plugin credential injection and credentials in arbitrary artifact HTTP
headers are disabled. Use a configured authenticated client that authorizes the
caller and consumes its credential within that client. Missing tool or agent
identity cannot satisfy a restrictive credential allowlist.

Provider clients, operator-managed CLI logins, installed integration code and
host filesystem access remain trusted runtime boundaries. A host terminal with
access to a credential file can read it; Octipus does not claim to prevent that
through command-string matching. Do not expose vault values to arbitrary
programs, even through environment variables: a program can encode them, put
them in argv, redirect them to a file or send them elsewhere before returning.

Diagnostic masking covers known active credentials and common raw, JSON,
URL, base64 and hex representations. It is defense in depth, not arbitrary
transformation tracking. If diagnostic redaction fails, details are withheld.
An unavailable or unsupported authenticated operation must fail closed rather
than falling back to secret-bearing shell execution.

The administrative credential-remediation repository scans owner-scoped current
records and supported history stores without passing plaintext as a search
parameter. Conditional updates preserve concurrent writes, advance affected plan
revisions, recompute note hashes and invalidate affected note embeddings. It
cannot erase PostgreSQL WAL, backups, opaque archives, third-party transcripts
or data already held by active workers. Report those separately and rotate any
exposed live credential. Git history rewriting requires a separate decision.

Authenticated HTTP, Git and explicitly trusted MCP transports can use named
[credential connection profiles](docs/AUTHENTICATED-CONNECTIONS.md). These retain
vault references in configuration and resolve authentication only inside the
credential-consuming transport. They do not restore shell/file interpolation.
The documentation states the trust boundary for approved remote endpoints, Git
pack content, stdio server code and unrestricted native host access.
