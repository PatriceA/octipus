/**
 * Importing a skill exchange bundle (docs/SKILL-EXCHANGE.md#importing): a
 * preview that writes nothing, then an install on the caller's explicit
 * confirmation. Both read the source again and check it from scratch — the
 * install also requires the content hash the preview showed, so what is
 * written is exactly what was reviewed.
 *
 * Who may do what follows the rules for creating and editing a skill by hand
 * (POST/PATCH /api/skills): anyone signed in creates their own personal
 * skills; a skill is replaced only by its owner or an administrator, and a
 * mounted SKILL.md never. A URL import is for administrators, through the
 * SSRF-guarded download plugin packages use, and needs a valid trusted
 * signature. Every skill written is audited.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '@/db/postgres';
import { skillRepository } from '@/db/repositories/skill-repository';
import { skills } from '@/db/schema/skills';
import type {
  SkillImportCollision,
  SkillImportDecision,
  SkillImportPreview,
  SkillImportResult,
  SkillImportSource,
  SkillImportSourceKind,
} from '@/shared/skill-exchange';
import { coreLogger } from '@/utils/logger';
import {
  type BundleTrust,
  checkBundleTrust,
  MAX_BUNDLE_BYTES,
  type ParsedImport,
  parseSkillBundle,
  parseSkillMdImport,
  SkillBundleError,
  skillNameSchema,
} from './exchange';
import { isExternalSkillId } from './external-loader';
import { getSkillRegistry } from './registry';

/** How long a URL import waits for the download. */
const URL_TIMEOUT_MS = 15_000;

/** Who is importing. `userId` is `'system'` for the single-user principal, whose skills have no owner. */
export interface ImportActor {
  userId: string;
  admin: boolean;
  /** A person writing in their own name (`isInPersonWrite`): an imported skill they own is locked against learning patches. */
  inPerson: boolean;
  /** The impersonating admin, when there is one (audited beside the user). */
  actorUserId?: string | null;
}

interface ReadSource {
  kind: SkillImportSourceKind;
  url: string | null;
  parsed: ParsedImport;
  trust: BundleTrust;
}

/** Read and check the one source a request names. */
async function readSource(source: SkillImportSource, actor: ImportActor): Promise<ReadSource> {
  const given = (['bundle', 'skillMd', 'url'] as const).filter((k) => source[k] !== undefined);
  if (given.length !== 1) throw new SkillBundleError('Give exactly one of bundle (the JSON text), skillMd (a SKILL.md) or url (an https bundle)');
  if (source.bundle !== undefined) {
    const parsed = parseSkillBundle(source.bundle);
    return { kind: 'bundle', url: null, parsed, trust: checkBundleTrust(parsed.contentHash, parsed.signature, { requireTrusted: false }) };
  }
  if (source.skillMd !== undefined) {
    const parsed = parseSkillMdImport(source.skillMd);
    return { kind: 'skill_md', url: null, parsed, trust: checkBundleTrust(parsed.contentHash, null, { requireTrusted: false }) };
  }
  const url = source.url as string;
  if (!actor.admin) throw new SkillBundleError('Only an administrator imports skills from a URL; download the bundle and upload it instead', 403);
  const { downloadHttps, RemoteFetchError } = await import('@/plugins/packages/remote');
  let bytes: Buffer;
  try {
    bytes = await downloadHttps(url, { maxBytes: MAX_BUNDLE_BYTES, timeoutMs: URL_TIMEOUT_MS, accept: 'application/json' });
  } catch (err) {
    if (err instanceof RemoteFetchError) throw new SkillBundleError(err.message);
    throw err;
  }
  const parsed = parseSkillBundle(bytes.toString('utf8'));
  return { kind: 'url', url, parsed, trust: checkBundleTrust(parsed.contentHash, parsed.signature, { requireTrusted: true }) };
}

/** The skills the caller sees, by lower-case name: what an imported name collides with. Their own copy wins a clash. */
async function collisions(actor: ImportActor): Promise<Map<string, SkillImportCollision>> {
  const owner = actor.userId === 'system' ? null : actor.userId;
  const out = new Map<string, SkillImportCollision>();
  for (const row of await getSkillRegistry().getAll(actor.userId)) {
    const kind: SkillImportCollision['kind'] = isExternalSkillId(row.id) ? 'mounted'
      : row.isSystem ? 'system'
      : row.userId === owner ? 'own'
      : 'shared';
    const key = row.name.trim().toLowerCase();
    if (out.has(key) && kind !== 'own') continue;
    out.set(key, { id: row.id, name: row.name, kind, canReplace: kind !== 'mounted' && (actor.admin || kind === 'own') });
  }
  return out;
}

/** What an import would do, written nowhere: the skills in full, the signature, the trust verdict and each name collision. */
export async function previewImport(source: SkillImportSource, actor: ImportActor): Promise<SkillImportPreview> {
  const read = await readSource(source, actor);
  const existing = await collisions(actor);
  return {
    source: read.kind,
    url: read.url,
    contentHash: read.parsed.contentHash,
    signature: read.trust.view,
    installable: read.trust.refusal === null,
    refusal: read.trust.refusal,
    warnings: [...read.parsed.warnings, ...read.trust.warnings],
    skills: read.parsed.skills.map((skill) => ({ skill, collision: existing.get(skill.name.trim().toLowerCase()) ?? null })),
  };
}

type Plan =
  | { kind: 'create'; index: number; name: string }
  | { kind: 'replace'; index: number; target: SkillImportCollision }
  | { kind: 'skip'; index: number };

/**
 * The write each bundle skill gets, all checked before anything is written:
 * a decision for every collision, renames that collide with nothing, and
 * replacements only of the colliding skill and only where allowed.
 */
function plan(parsed: ParsedImport, decisions: readonly SkillImportDecision[], existing: Map<string, SkillImportCollision>): Plan[] {
  const byName = new Map<string, SkillImportDecision>();
  const names = new Set(parsed.skills.map((s) => s.name));
  for (const d of decisions) {
    if (!names.has(d.name)) throw new SkillBundleError(`A decision names "${d.name}", which is not a skill in the bundle`);
    if (byName.has(d.name)) throw new SkillBundleError(`Two decisions name "${d.name}"`);
    byName.set(d.name, d);
  }
  const taken = new Set(parsed.skills.map((s) => s.name.trim().toLowerCase()));
  const plans: Plan[] = [];
  parsed.skills.forEach((skill, index) => {
    const collision = existing.get(skill.name.trim().toLowerCase()) ?? null;
    const decision = byName.get(skill.name) ?? { name: skill.name, action: 'create' as const };
    switch (decision.action) {
      case 'skip':
        plans.push({ kind: 'skip', index });
        return;
      case 'create':
        if (collision) {
          throw new SkillBundleError(`"${skill.name}" has the same name as ${collision.kind === 'own' ? 'your' : `a ${collision.kind}`} skill "${collision.name}": choose skip, rename or replace for it`, 409);
        }
        plans.push({ kind: 'create', index, name: skill.name });
        return;
      case 'rename': {
        const checked = skillNameSchema.safeParse(decision.newName);
        if (!checked.success) throw new SkillBundleError(`The new name for "${skill.name}" ${checked.error.issues[0]?.message ?? 'is not valid'}`);
        const key = decision.newName.trim().toLowerCase();
        const clash = existing.get(key);
        if (clash) throw new SkillBundleError(`The new name "${decision.newName}" is taken by the skill "${clash.name}"`, 409);
        if (taken.has(key)) throw new SkillBundleError(`The new name "${decision.newName}" is used by another skill in this import`, 409);
        taken.add(key);
        plans.push({ kind: 'create', index, name: decision.newName });
        return;
      }
      case 'replace':
        if (!collision) throw new SkillBundleError(`"${skill.name}" collides with no skill; there is nothing to replace`);
        if (collision.id !== decision.skillId) throw new SkillBundleError(`"${skill.name}" can replace only the skill it collides with ("${collision.name}")`);
        if (!collision.canReplace) {
          throw new SkillBundleError(collision.kind === 'mounted'
            ? `"${collision.name}" is a mounted SKILL.md, read-only in Octipus; rename or skip the imported skill`
            : `Only its owner or an administrator replaces "${collision.name}"; rename or skip the imported skill`, 403);
        }
        plans.push({ kind: 'replace', index, target: collision });
        return;
    }
  });
  return plans;
}

/**
 * Install an import on the caller's confirmation: the source read and checked
 * again, the content hash the preview showed required, every decision checked,
 * then every write in one transaction. A created skill is the caller's own
 * personal skill (never system, never an organization's), with no embedding
 * yet — the backfill embeds it as it does a skill made on the Skills page; a
 * replaced skill keeps its id, owner and assignments, and its embedding is
 * cleared when its name or description changes (skillRepository.update).
 */
export async function installImport(
  source: SkillImportSource,
  expectedContentHash: string,
  decisions: readonly SkillImportDecision[],
  actor: ImportActor,
): Promise<SkillImportResult> {
  const read = await readSource(source, actor);
  if (read.parsed.contentHash !== expectedContentHash) {
    throw new SkillBundleError(`The source now hashes to ${read.parsed.contentHash}, not to the ${expectedContentHash} that was previewed; preview it again`, 409);
  }
  if (read.trust.refusal !== null) throw new SkillBundleError(read.trust.refusal);
  const plans = plan(read.parsed, decisions, await collisions(actor));
  const owner = actor.userId === 'system' ? null : actor.userId;
  const now = new Date();
  const result: SkillImportResult = { created: [], replaced: [], skipped: [], contentHash: read.parsed.contentHash, signature: read.trust.view };

  await getDb().transaction(async (tx) => {
    for (const p of plans) {
      const skill = read.parsed.skills[p.index];
      if (p.kind === 'skip') {
        result.skipped.push(skill.name);
      } else if (p.kind === 'create') {
        const id = randomUUID();
        await tx.insert(skills).values({
          id,
          ...skill,
          name: p.name,
          isSystem: false,
          userId: owner,
          orgId: null,
          ownerEditedAt: actor.inPerson ? now : null,
        });
        result.created.push({ id, name: p.name });
      } else {
        const ownTarget = p.target.kind === 'own';
        const updated = await skillRepository.update(p.target.id, {
          ...skill,
          ...(actor.inPerson && ownTarget ? { ownerEditedAt: now } : {}),
        }, tx);
        if (!updated) throw new SkillBundleError(`The skill "${p.target.name}" no longer exists; preview the import again`, 409);
        result.replaced.push({ id: p.target.id, name: skill.name });
      }
    }
  });

  await auditImport(read, result, actor);
  return result;
}

/** One audit row per skill written: what, from where, signed by whom, by whom. */
async function auditImport(read: ReadSource, result: SkillImportResult, actor: ImportActor): Promise<void> {
  const { auditRepository } = await import('@/db/repositories/audit-repository');
  const common = {
    source: read.kind,
    ...(read.url ? { url: read.url } : {}),
    contentHash: read.parsed.contentHash,
    signature: read.trust.view.status,
    publisher: read.trust.view.publisher,
    keyId: read.trust.view.keyId,
    ...(actor.actorUserId ? { actorUserId: actor.actorUserId } : {}),
  };
  const rows = [
    ...result.created.map((s) => ({ op: 'skill_imported', ...s })),
    ...result.replaced.map((s) => ({ op: 'skill_replaced_by_import', ...s })),
  ];
  for (const row of rows) {
    await auditRepository.log({
      userId: actor.userId, action: 'settings_changed', resourceType: 'skill', resourceId: row.id,
      details: { op: row.op, name: row.name, ...common },
    });
  }
  coreLogger.info({ created: result.created.length, replaced: result.replaced.length, skipped: result.skipped.length, source: read.kind, signature: read.trust.view.status }, 'Skill bundle imported');
}
