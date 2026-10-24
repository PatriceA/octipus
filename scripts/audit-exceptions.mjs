// Which findings of an `npm audit --json` report are accepted exceptions
// (scripts/audit-exceptions.json). An exception names one advisory, the one
// package it is in, and the only packages it may sit under; anything else in
// the report, a new advisory on those same packages included, still fails.

/** The advisory id (GHSA-…) of an advisory entry in a report's `via`. */
function advisoryId(via) {
  const url = typeof via.url === 'string' ? via.url : '';
  return url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0] ?? String(via.source ?? via.title ?? 'unknown');
}

/** Every node path of `name` sits inside one of `under` (node_modules/<parent>/node_modules/<name>). */
function onlyUnder(nodes, name, under) {
  return nodes.length > 0 && nodes.every((node) => under.some((parent) => node === `node_modules/${parent}/node_modules/${name}`));
}

/**
 * The findings of `report` for `folder` that no exception covers, and the
 * exceptions past their review date (`today`: YYYY-MM-DD).
 */
export function auditFindings(report, exceptions, folder, today) {
  const mine = exceptions.filter((e) => e.folder === folder);
  const expired = mine.filter((e) => e.reviewBy < today);
  const live = mine.filter((e) => e.reviewBy >= today);
  const vulns = report?.vulnerabilities ?? {};
  const accepted = new Set();
  const advisoriesOf = (v) => (v.via ?? []).filter((x) => typeof x === 'object');
  const dependsOn = (v) => (v.via ?? []).filter((x) => typeof x === 'string');

  // A package whose own advisories are all excepted, where they sit.
  for (const [name, v] of Object.entries(vulns)) {
    const own = advisoriesOf(v);
    if (own.length === 0) continue;
    const covered = own.every((a) => live.some((e) => e.package === name && e.advisory === advisoryId(a) && onlyUnder(v.nodes ?? [], name, e.under)));
    if (covered && dependsOn(v).length === 0) accepted.add(name);
  }
  // A package flagged only for depending on accepted ones, when an exception lets that package hold it.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, v] of Object.entries(vulns)) {
      if (accepted.has(name) || advisoriesOf(v).length > 0) continue;
      const deps = dependsOn(v);
      if (deps.length > 0 && deps.every((d) => accepted.has(d)) && live.some((e) => e.under.includes(name))) {
        accepted.add(name);
        grew = true;
      }
    }
  }
  const open = Object.entries(vulns)
    .filter(([name]) => !accepted.has(name))
    .map(([name, v]) => ({ name, severity: v.severity, advisories: advisoriesOf(v).map((a) => `${advisoryId(a)} ${a.title ?? ''}`.trim()), dependsOn: dependsOn(v) }));
  return { open, accepted: [...accepted], expired };
}
