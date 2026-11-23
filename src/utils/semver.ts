/** Semantic versions, compared (plugin packages, skill registries). Pure. */

/**
 * Compare two semantic versions (`1.2.0`, `1.2.0-beta.1`): negative when `a`
 * is older. A pre-release is older than its release; pre-release identifiers
 * compare numerically when both are numbers, else as text.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = a.split(/-(.*)/s, 2);
  const [coreB, preB] = b.split(/-(.*)/s, 2);
  const na = coreA.split('.').map(Number);
  const nb = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  const pa = preA.split('.');
  const pb = preB.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    if (pa[i] === pb[i]) continue;
    const xa = /^\d+$/.test(pa[i]) ? Number(pa[i]) : null;
    const xb = /^\d+$/.test(pb[i]) ? Number(pb[i]) : null;
    if (xa !== null && xb !== null) return xa - xb;
    if (xa !== null) return -1;
    if (xb !== null) return 1;
    return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
