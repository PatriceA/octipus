# Audit exceptions and the legacy allowlist

## CI: `scripts/audit-exceptions.json`

CI runs `npm run audit:all` in `.github/workflows/dependency-audit.yml` on pull
requests, pushes to main, and daily. It checks all three npm lockfiles, including
development dependencies, and fails on any reported vulnerability or audit error
that `scripts/audit-exceptions.json` does not accept (`scripts/audit-exceptions.mjs`
decides). Each entry:

```jsonc
{
  "folder": "web",                       // ".", "web" or "mcp-server"
  "advisory": "GHSA-fc5q-39xc-vjpf",     // one advisory
  "package": "picomatch",                // the one package it is in
  "hoisted": true,                       // optional, see below
  "under": ["vite", "tinyglobby"],       // the only packages it may sit under / be pulled in by
  "reason": "…why it does not affect us, and what removes the entry…",
  "reviewBy": "2026-11-24"               // the audit fails again after this day
}
```

- Without `hoisted`, every copy of the package must sit nested under a listed
  parent (`node_modules/<parent>/node_modules/<package>`).
- With `hoisted: true`, a top-level copy (`node_modules/<package>`) is also
  accepted, as long as the package is not a direct dependency and every package
  the report flags as depending on it is listed in `under`. When no fixed
  version exists every dependent is flagged, so a new consumer fails the audit.
- Packages flagged only because they depend on accepted ones are accepted when
  listed in `under`, cycles between them included.
- Another advisory on the same package, another folder, or a past `reviewBy`
  fails the audit. Keep review dates days or weeks away, not months.

## Legacy local diagnostic: `scripts/audit-allowlist.json`

`scripts/audit-allowlist.json` is used only by the legacy local diagnostic
`scripts/audit-check.ts`, which CI does not run:

```
npx tsx scripts/audit-check.ts
```

The check runs `npm audit --omit=dev --json`, and fails (exit 1) if **any** reported
advisory is not covered by an un-expired entry here — or if any entry here has
itself expired (so stale exceptions are noticed and cleaned up).

## File shape

The file is a JSON array of entries. Each entry:

```jsonc
[
  {
    // Advisory id to ignore. Either the numeric npm advisory id
    // (e.g. "1120743") OR the GHSA identifier (e.g. "GHSA-hmw2-7cc7-3qxx").
    // Matching is done against both the numeric id and the GHSA of each
    // reported advisory, so either form works.
    "id": "GHSA-hmw2-7cc7-3qxx",

    // Why this advisory is accepted. Be specific: why it does not affect us,
    // what the remediation blocker is, tracking issue link, etc.
    "reason": "Transitive dev-adjacent dep; not reachable in prod code path. Tracked in #123.",

    // Expiry date, YYYY-MM-DD. After this date the exception is treated as
    // stale and the audit FAILS until the entry is removed or renewed.
    // Keep this short (weeks, not years) so exceptions are revisited.
    "expires": "2026-09-01"
  }
]
```

## Rules

- An advisory is ignored **only** if a matching entry exists **and** its
  `expires` date has not passed (day granularity, UTC). The expiry date itself
  is still considered valid; the day after it is not.
- A missing or unparseable `expires` is treated as **already expired** — an
  exception with no valid expiry does not silently pass.
- Any expired entry causes the audit to fail even if the underlying advisory is
  no longer reported, forcing cleanup of dead exceptions.

## Adding an exception

1. Run `npx tsx scripts/audit-check.ts` locally to see the blocking advisory id.
2. Add an entry with a real `reason` and a near-term `expires`.
3. Re-run the check; it should now pass.
4. The entry shows up in the diff, so acceptance is reviewable in the PR.
