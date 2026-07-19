/**
 * Sibling scope registry (Phase 2.5, cheap version).
 *
 * Two children spawned in the same session can silently clobber each other's
 * work — the QA run's codex child wrote a correct `android/key.properties`,
 * then a later automation child overwrote it with a broken one, with no
 * awareness between them. This module records, per session, which files each
 * child touched (from `file_change` events) and each child's final report, and
 * builds a briefing block injected into every SUBSEQUENT child's message:
 *
 *   - always: "files already changed this session" (path + which role);
 *   - for a child whose mandate OVERLAPS a sibling's (shared topic-path
 *     segment or a touched path): that sibling's final report too.
 *
 * In-memory and best-effort — parallel siblings spawned in the same turn won't
 * see each other (recording happens on completion), which is acceptable for the
 * cheap version. Cleared when a session's swarm tree is torn down.
 *
 * ponytail: in-memory Map, unbounded per live session; add an LRU/TTL sweep if
 * long-lived sessions accumulate too many entries.
 */

interface TouchedPath {
  path: string;
  nodeId: string;
  role: string;
}

interface SiblingReport {
  nodeId: string;
  role: string;
  topicPath: string;
  report: string;
}

interface SessionScope {
  touched: TouchedPath[];
  reports: SiblingReport[];
}

const scopes = new Map<string, SessionScope>();
const MAX_REPORT_CHARS = 1_500;
const MAX_LISTED_FILES = 40;

function getScope(sessionId: string): SessionScope {
  let s = scopes.get(sessionId);
  if (!s) {
    s = { touched: [], reports: [] };
    scopes.set(sessionId, s);
  }
  return s;
}

/** Record a completed child's touched paths + final report for its siblings. */
export function recordChildScope(
  sessionId: string,
  entry: { nodeId: string; role: string; topicPath: string; paths: string[]; report: string },
): void {
  if (!sessionId) return;
  const scope = getScope(sessionId);
  for (const path of entry.paths) {
    if (!path) continue;
    if (scope.touched.some((t) => t.path === path && t.nodeId === entry.nodeId)) continue;
    scope.touched.push({ path, nodeId: entry.nodeId, role: entry.role });
  }
  const report = entry.report?.trim();
  if (report) {
    scope.reports.push({
      nodeId: entry.nodeId,
      role: entry.role,
      topicPath: entry.topicPath,
      report: report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}…` : report,
    });
  }
}

/** Segments of a topic path, minus the "root" anchor, lowercased. */
function pathSegments(topicPath: string): Set<string> {
  return new Set(
    topicPath
      .split('/')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && s !== 'root'),
  );
}

/**
 * Build the sibling-scope briefing for a child about to be spawned. Empty
 * string when there's nothing to report (so callers can append unconditionally).
 */
export function buildSiblingScopeBrief(
  sessionId: string,
  opts: { topicPath: string; excludeNodeId?: string },
): string {
  const scope = scopes.get(sessionId);
  if (!scope) return '';
  const touched = scope.touched.filter((t) => t.nodeId !== opts.excludeNodeId);
  const reports = scope.reports.filter((r) => r.nodeId !== opts.excludeNodeId);
  if (touched.length === 0 && reports.length === 0) return '';

  const parts: string[] = [];
  if (touched.length > 0) {
    const listed = touched.slice(0, MAX_LISTED_FILES).map((t) => `- ${t.path} (by ${t.role})`);
    const extra = touched.length > listed.length ? `\n- …and ${touched.length - listed.length} more` : '';
    parts.push(
      'FILES ALREADY CHANGED THIS SESSION by sibling agents — do NOT blindly overwrite ' +
        'them; read the current contents first and preserve prior work:\n' +
        listed.join('\n') + extra,
    );
  }

  // Overlapping mandate → include the sibling's final report so this child sees
  // what was decided/produced there.
  const mySegments = pathSegments(opts.topicPath);
  const overlapping = reports.filter((r) => {
    const segs = pathSegments(r.topicPath);
    for (const s of segs) if (mySegments.has(s)) return true;
    return false;
  });
  if (overlapping.length > 0) {
    parts.push(
      'RELATED SIBLING WORK (overlapping mandate) — build on this instead of redoing it. ' +
        'Do not contradict it arbitrarily, but if you find it is clearly wrong, correct it ' +
        'and state what you changed and why:\n' +
        overlapping
          .map((r) => `[${r.role} @ ${r.topicPath}]\n${r.report}`)
          .join('\n\n'),
    );
  }
  return parts.join('\n\n');
}

/** Drop a session's scope. Call when the session's swarm tree is torn down. */
export function clearSessionScope(sessionId: string): void {
  scopes.delete(sessionId);
}
