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
