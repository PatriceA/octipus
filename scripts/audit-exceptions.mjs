// Which findings of an `npm audit --json` report are accepted exceptions
// (scripts/audit-exceptions.json). An exception names one advisory, the one
// package it is in, and the only packages it may sit under; anything else in
// the report, a new advisory on those same packages included, still fails.
//
// `hoisted: true` also accepts the package at the top level of node_modules,
// where npm puts a dependency several packages share. "Under" then means
// "depended on by": the package must not be a direct dependency, and every
// package the report flags as depending on it must be in `under`. When no
// fixed version exists every dependent is flagged, so a new consumer of the
// package fails the audit again instead of being accepted silently.

/** The advisory id (GHSA-…) of an advisory entry in a report's `via`. */
function advisoryId(via) {
  const url = typeof via.url === 'string' ? via.url : '';
  return url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0] ?? String(via.source ?? via.title ?? 'unknown');
}

/** The packages the report flags as depending on `name`. */
function dependentsOf(vulns, name) {
  return Object.entries(vulns).filter(([, v]) => (v.via ?? []).includes(name)).map(([dependent]) => dependent);
}

/**
 * Every node path of `name` sits inside one of the exception's parents
 * (node_modules/<parent>/node_modules/<name>), or, for a `hoisted` exception,
 * at the top level of an indirect dependency whose flagged dependents are all parents.
 */
function placedAsAccepted(vulns, name, exception) {
  const nodes = vulns[name]?.nodes ?? [];
  const hoistedOk = () => exception.hoisted === true && vulns[name]?.isDirect !== true
    && dependentsOf(vulns, name).every((dependent) => exception.under.includes(dependent));
  return nodes.length > 0 && nodes.every((node) =>
    exception.under.some((parent) => node === `node_modules/${parent}/node_modules/${name}`)
    || (node === `node_modules/${name}` && hoistedOk()));
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
    const covered = own.every((a) => live.some((e) => e.package === name && e.advisory === advisoryId(a) && placedAsAccepted(vulns, name, e)));
    if (covered && dependsOn(v).length === 0) accepted.add(name);
  }
  // A package flagged only for depending on accepted ones, when an exception
  // lets that package hold it. Dependents can depend on each other (vitest and
  // @vitest/coverage-v8 do), so this is the largest set whose members depend
  // only on accepted packages or on each other, not a one-way sweep that would
  // wait forever on a cycle. Each member must still reach an accepted advisory.
  const candidates = new Set(Object.entries(vulns)
    .filter(([name, v]) => !accepted.has(name) && advisoriesOf(v).length === 0 && dependsOn(v).length > 0 && live.some((e) => e.under.includes(name)))
    .map(([name]) => name));
  let shrunk = true;
  while (shrunk) {
    shrunk = false;
    for (const name of candidates) {
      if (!dependsOn(vulns[name]).every((d) => accepted.has(d) || candidates.has(d))) {
        candidates.delete(name);
        shrunk = true;
      }
    }
  }
  const reachesAccepted = (name, seen = new Set()) => {
    if (accepted.has(name)) return true;
    if (seen.has(name) || !candidates.has(name)) return false;
    seen.add(name);
    return dependsOn(vulns[name]).some((d) => reachesAccepted(d, seen));
  };
  for (const name of [...candidates].filter((n) => reachesAccepted(n))) accepted.add(name);
  const open = Object.entries(vulns)
    .filter(([name]) => !accepted.has(name))
    .map(([name, v]) => ({ name, severity: v.severity, advisories: advisoriesOf(v).map((a) => `${advisoryId(a)} ${a.title ?? ''}`.trim()), dependsOn: dependsOn(v) }));
  return { open, accepted: [...accepted], expired };
}
