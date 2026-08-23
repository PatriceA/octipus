# Audit allowlist format

`scripts/audit-allowlist.json` is a reviewable list of dependency advisories we
have consciously accepted. It is consulted by `scripts/audit-check.ts`, which is
run in CI (`.github/workflows/ci.yml`, backend job) as a **blocking** step:

```
npx tsx scripts/audit-check.ts
```

The check runs `bun audit --prod --json`, and fails (exit 1) if **any** reported
advisory is not covered by an un-expired entry here — or if any entry here has
itself expired (so stale exceptions are noticed and cleaned up).

## File shape

The file is a JSON array of entries. Each entry:

```jsonc
[
  {
    // Advisory id to ignore. Either the numeric bun/npm advisory id
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
