#!/usr/bin/env tsx
/**
 * audit-check.ts — blocking dependency audit with a reviewable allowlist.
 *
 * Runs `bun audit --prod --json`, parses the result, and fails (exit 1) if any
 * advisory is NOT covered by an un-expired entry in `scripts/audit-allowlist.json`.
 * Also fails if any allowlist entry is itself expired, so stale exceptions get
 * noticed and cleaned up rather than silently lingering.
 *
 * See `scripts/audit-allowlist.README.md` for the allowlist format.
 *
 * The pure decision logic lives in `evaluateAdvisories` so it can be unit-tested
 * without shelling out to `bun audit`; this file is the thin CLI wrapper.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { runCommand } from '@/utils/proc';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Advisory {
  /** Numeric advisory id as a string (e.g. "1120743"), if present. */
  id?: string;
  /** GHSA identifier (e.g. "GHSA-hmw2-7cc7-3qxx"), if derivable. */
  ghsa?: string;
  severity?: string;
  title?: string;
  /** Affected package name (bun keys advisories by package). */
  package?: string;
  /** Original advisory url, kept for reporting. */
  url?: string;
}

export interface AllowlistEntry {
  /** Advisory id OR GHSA to ignore. */
  id: string;
  reason: string;
  /** Expiry date, "YYYY-MM-DD". After this date the exception is stale. */
  expires: string;
}

export interface EvaluationResult {
  /** Every advisory bun reported (normalized). */
  found: Advisory[];
  /** Advisories matched to an un-expired allowlist entry. */
  allowlisted: Array<{ advisory: Advisory; entry: AllowlistEntry }>;
  /** Advisories that must block: no matching entry, or the matching entry expired. */
  blocking: Advisory[];
  /** Allowlist entries whose expiry has passed (or is missing/invalid). */
  expiredEntries: AllowlistEntry[];
  /** True when CI should fail. */
  shouldFail: boolean;
}

// ---------------------------------------------------------------------------
// Pure logic (unit-tested)
// ---------------------------------------------------------------------------

/** Candidate identifiers an allowlist entry may match against for an advisory. */
function advisoryIdentifiers(a: Advisory): string[] {
  const ids: string[] = [];
  if (a.id) ids.push(String(a.id));
  if (a.ghsa) ids.push(a.ghsa);
  if (a.url) {
    const m = a.url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
    if (m) ids.push(m[0]);
  }
  return ids;
}

function idsMatch(entryId: string, advisory: Advisory): boolean {
  const target = entryId.trim().toLowerCase();
  return advisoryIdentifiers(advisory).some((id) => id.toLowerCase() === target);
}

/**
 * An entry is expired when its `expires` date is strictly before `now`
 * (day granularity, UTC). A missing or unparseable `expires` counts as
 * expired — an exception with no valid expiry is treated as stale so it
 * surfaces for review rather than lingering forever.
 */
export function isExpired(entry: AllowlistEntry, now: Date): boolean {
  if (!entry.expires || typeof entry.expires !== 'string') return true;
  const parsed = Date.parse(`${entry.expires}T00:00:00Z`);
  if (Number.isNaN(parsed)) return true;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return parsed < today;
}

/**
 * Decide, for a set of advisories and an allowlist, which are tolerated and
 * which block. Pure — no I/O — so it is fully unit-testable.
 */
export function evaluateAdvisories(
  advisories: Advisory[],
  allowlist: AllowlistEntry[],
  now: Date,
): EvaluationResult {
  const allowlisted: EvaluationResult['allowlisted'] = [];
  const blocking: Advisory[] = [];

  for (const advisory of advisories) {
    const entry = allowlist.find((e) => idsMatch(e.id, advisory));
    if (entry && !isExpired(entry, now)) {
      allowlisted.push({ advisory, entry });
    } else {
      // No entry, or the entry that would cover it is expired → block.
      blocking.push(advisory);
    }
  }

  // Any expired entry at all is a failure so stale exceptions get noticed.
  const expiredEntries = allowlist.filter((e) => isExpired(e, now));

  return {
    found: advisories,
    allowlisted,
    blocking,
    expiredEntries,
    shouldFail: blocking.length > 0 || expiredEntries.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Parsing bun's output (defensive)
// ---------------------------------------------------------------------------

/**
 * Normalize the many shapes `bun audit --json` might emit into a flat list of
 * advisories. Observed shape (bun 1.3.x) is a map of `{ pkg: Advisory[] }`, but
 * we also tolerate `{ advisories: ... }` and a bare array to be future-proof.
 *
 * Throws if the input is a non-empty string that does not parse or does not
 * match any known shape — the caller prints the raw output and exits 1 rather
 * than silently passing.
 */
export function parseAuditOutput(raw: string): Advisory[] {
  const trimmed = raw.trim();
  // Clean / no output → no vulnerabilities.
  if (trimmed === '' || trimmed === '{}' || trimmed === '[]' || trimmed === 'null') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('audit output is not valid JSON');
  }

  // Shape: { advisories: <object|array> } — unwrap first.
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'advisories' in (parsed as Record<string, unknown>)
  ) {
    parsed = (parsed as Record<string, unknown>).advisories;
  }

  const out: Advisory[] = [];

  const pushOne = (obj: unknown, pkg?: string) => {
    if (!obj || typeof obj !== 'object') return;
    const o = obj as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url : undefined;
    let ghsa: string | undefined;
    if (typeof o.ghsa === 'string') ghsa = o.ghsa;
    else if (typeof o.id === 'string' && /^GHSA-/i.test(o.id)) ghsa = o.id;
    else if (url) {
      const m = url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
      if (m) ghsa = m[0];
    }
    out.push({
      id: o.id != null ? String(o.id) : undefined,
      ghsa,
      severity: typeof o.severity === 'string' ? o.severity : undefined,
      title: typeof o.title === 'string' ? o.title : undefined,
      package:
        pkg ??
        (typeof o.module_name === 'string'
          ? o.module_name
          : typeof o.name === 'string'
            ? o.name
            : undefined),
      url,
    });
  };

  if (Array.isArray(parsed)) {
    // Bare array of advisory objects.
    for (const item of parsed) pushOne(item);
    return out;
  }

  if (parsed && typeof parsed === 'object') {
    // Map of pkg -> Advisory[] (or pkg -> Advisory).
    for (const [pkg, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const item of value) pushOne(item, pkg);
      } else if (value && typeof value === 'object') {
        pushOne(value, pkg);
      }
    }
    return out;
  }

  throw new Error('audit output did not match any known shape');
}

// ---------------------------------------------------------------------------
// Allowlist loading
// ---------------------------------------------------------------------------

export function loadAllowlist(path: string): AllowlistEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // No allowlist file → treat as empty (nothing tolerated).
    return [];
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array of allowlist entries`);
  }
  return parsed as AllowlistEntry[];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function runBunAudit(): Promise<{ stdout: string; stderr: string }> {
  return runCommand(['bun', 'audit', '--prod', '--json']);
}

function report(result: EvaluationResult): void {
  const { found, allowlisted, blocking, expiredEntries } = result;

  console.log('── Dependency audit (bun audit --prod) ──');
  console.log(`Advisories found: ${found.length}`);

  if (found.length > 0) {
    for (const a of found) {
      const idLabel = a.ghsa ?? a.id ?? '(unknown id)';
      console.log(
        `  • ${a.package ?? '?'} — ${idLabel} [${a.severity ?? 'unknown'}] ${a.title ?? ''}`.trimEnd(),
      );
    }
  }

  if (allowlisted.length > 0) {
    console.log('');
    console.log(`Allow-listed (ignored): ${allowlisted.length}`);
    for (const { advisory, entry } of allowlisted) {
      const idLabel = advisory.ghsa ?? advisory.id ?? entry.id;
      console.log(
        `  • ${advisory.package ?? '?'} — ${idLabel}: ${entry.reason} (expires ${entry.expires})`,
      );
    }
  }

  if (expiredEntries.length > 0) {
    console.log('');
    console.log(`Expired allowlist entries (must be removed/renewed): ${expiredEntries.length}`);
    for (const e of expiredEntries) {
      console.log(`  • ${e.id}: expired ${e.expires} — ${e.reason}`);
    }
  }

  if (blocking.length > 0) {
    console.log('');
    console.log(`BLOCKING advisories (not allow-listed): ${blocking.length}`);
    for (const a of blocking) {
      const idLabel = a.ghsa ?? a.id ?? '(unknown id)';
      console.log(
        `  • ${a.package ?? '?'} — ${idLabel} [${a.severity ?? 'unknown'}] ${a.title ?? ''}`.trimEnd(),
      );
    }
    console.log('');
    console.log(
      'To accept one of these, add an entry to scripts/audit-allowlist.json ' +
        '(see scripts/audit-allowlist.README.md).',
    );
  }
}

async function main(): Promise<void> {
  const allowlistPath = join(import.meta.dirname, 'audit-allowlist.json');

  const { stdout, stderr } = await runBunAudit();

  let advisories: Advisory[];
  try {
    advisories = parseAuditOutput(stdout);
  } catch (err) {
    console.error('Failed to parse `bun audit --prod --json` output:');
    console.error((err as Error).message);
    console.error('--- raw stdout ---');
    console.error(stdout);
    if (stderr.trim()) {
      console.error('--- raw stderr ---');
      console.error(stderr);
    }
    process.exit(1);
  }

  let allowlist: AllowlistEntry[];
  try {
    allowlist = loadAllowlist(allowlistPath);
  } catch (err) {
    console.error(`Failed to load allowlist (${allowlistPath}):`);
    console.error((err as Error).message);
    process.exit(1);
  }

  const result = evaluateAdvisories(advisories, allowlist, new Date());
  report(result);

  if (result.shouldFail) {
    console.log('');
    console.log('❌ Audit failed.');
    process.exit(1);
  }

  console.log('');
  console.log('✅ Audit passed — no un-allowlisted advisories.');
  process.exit(0);
}

// Only run the CLI when executed directly (not when imported by the test).
if (import.meta.main) {
  main();
}
