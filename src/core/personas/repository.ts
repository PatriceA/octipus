import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type Profile, type ProfileFact, profiles } from '@/db/schema/profiles';

/**
 * Persona profiles live in the same `profiles` table as user-context
 * profiles, distinguished by `category='assistant'` and pinned per
 * user. Exactly one assistant profile per user.
 *
 * Fact keys this repository writes/reads:
 *   - `preset_id`    — which YAML preset seeded this profile ("octipus")
 *   - `pronouns`     — render hint for prompt block
 *   - `tone`         — one of PersonaTone
 *   - `narration`    — one of PersonaNarration
 *   - `extra:<n>`    — user-added free-form facts via `/persona say`
 *   - `arm:<role>`   — persona preset shadowing one arm (`/persona arm`)
 *
 * The profile's `name` column holds the renderable name ("Octipus",
 * or whatever the user picked).
 */
export const ASSISTANT_CATEGORY = 'assistant';

export interface AssistantProfileFields {
  presetId: string;
  pronouns: string;
  tone: string;
  narration: string;
  extras: string[];
  /**
   * Per-arm persona shadowing: role → preset id, from the `arm:<role>` facts.
   * Empty for every role the user has not bound, which is the normal case — an
   * unbound arm gets no persona block at all, exactly as before.
   */
  armPresets: Record<string, string>;
}

/** Fact key holding the persona bound to one arm. */
export const armFactKey = (role: string) => `arm:${role}`;

export class PersonaProfileRepository {
  private get db() { return getDb(); }

  /**
   * Return the user's assistant profile or null. There should never be
   * more than one — if duplicates exist, the most recently updated wins
   * (and a warning is logged at the caller).
   */
  async findForUser(userId: string): Promise<Profile | null> {
    const rows = await this.db
      .select()
      .from(profiles)
      .where(and(
        eq(profiles.userId, userId),
        eq(profiles.category, ASSISTANT_CATEGORY),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a fresh assistant profile. Arm bindings are excluded from the
   * argument on purpose — a new profile has none, and accepting them here
   * would offer a second way to write what `/persona arm` owns.
   */
  async create(userId: string, name: string, fields: Omit<AssistantProfileFields, 'armPresets'>): Promise<Profile> {
    const facts: ProfileFact[] = [
      { key: 'preset_id', value: fields.presetId, source: 'system', learnedAt: new Date().toISOString() },
      { key: 'pronouns', value: fields.pronouns, source: 'system', learnedAt: new Date().toISOString() },
      { key: 'tone', value: fields.tone, source: 'system', learnedAt: new Date().toISOString() },
      { key: 'narration', value: fields.narration, source: 'system', learnedAt: new Date().toISOString() },
      ...fields.extras.map((value, idx) => ({
        key: `extra:${idx}`,
        value,
        source: 'user',
        learnedAt: new Date().toISOString(),
      })),
    ];
    const rows = await this.db.insert(profiles).values({
      userId,
      name,
      category: ASSISTANT_CATEGORY,
      relationship: 'self',
      isUserProfile: false,
      facts,
    }).returning();
    return rows[0];
  }

  async updateName(profileId: string, name: string): Promise<Profile | null> {
    const rows = await this.db
      .update(profiles)
      .set({ name, updatedAt: new Date() })
      .where(eq(profiles.id, profileId))
      .returning();
    return rows[0] ?? null;
  }

  async upsertFact(profileId: string, key: string, value: string, source = 'system'): Promise<Profile | null> {
    const existing = await this.findById(profileId);
    if (!existing) return null;
    const facts = ((existing.facts as ProfileFact[]) || []).filter(f => f.key !== key);
    facts.push({ key, value, source, learnedAt: new Date().toISOString() });
    const rows = await this.db
      .update(profiles)
      .set({ facts, updatedAt: new Date() })
      .where(eq(profiles.id, profileId))
      .returning();
    return rows[0] ?? null;
  }

  /** Append a free-form user-added fact under `extra:<n>`. */
  async addExtraFact(profileId: string, value: string): Promise<Profile | null> {
    const existing = await this.findById(profileId);
    if (!existing) return null;
    const facts = (existing.facts as ProfileFact[]) || [];
    const extraKeys = facts
      .filter(f => f.key.startsWith('extra:'))
      .map(f => Number(f.key.slice('extra:'.length)))
      .filter(n => !Number.isNaN(n));
    const nextIdx = extraKeys.length === 0 ? 0 : Math.max(...extraKeys) + 1;
    facts.push({ key: `extra:${nextIdx}`, value, source: 'user', learnedAt: new Date().toISOString() });
    const rows = await this.db
      .update(profiles)
      .set({ facts, updatedAt: new Date() })
      .where(eq(profiles.id, profileId))
      .returning();
    return rows[0] ?? null;
  }

  async reset(profileId: string): Promise<Profile | null> {
    const rows = await this.db
      .update(profiles)
      .set({
        name: 'Octipus',
        facts: [
          { key: 'preset_id', value: 'octipus', source: 'system', learnedAt: new Date().toISOString() },
          { key: 'pronouns', value: 'it/we', source: 'system', learnedAt: new Date().toISOString() },
          { key: 'tone', value: 'dry', source: 'system', learnedAt: new Date().toISOString() },
          { key: 'narration', value: 'minimal', source: 'system', learnedAt: new Date().toISOString() },
        ],
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, profileId))
      .returning();
    return rows[0] ?? null;
  }

  /** Drop one fact by key. Used to unbind an arm's persona. */
  async removeFact(profileId: string, key: string): Promise<Profile | null> {
    const existing = await this.findById(profileId);
    if (!existing) return null;
    const facts = ((existing.facts as ProfileFact[]) || []).filter(f => f.key !== key);
    const rows = await this.db
      .update(profiles)
      .set({ facts, updatedAt: new Date() })
      .where(eq(profiles.id, profileId))
      .returning();
    return rows[0] ?? null;
  }

  async findById(profileId: string): Promise<Profile | null> {
    const rows = await this.db.select().from(profiles).where(eq(profiles.id, profileId)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Read the structured fields out of a profile row. Missing values
   * fall back to base-persona defaults.
   */
  static toFields(profile: Profile): AssistantProfileFields {
    const facts = (profile.facts as ProfileFact[]) || [];
    const find = (key: string, fallback: string) =>
      facts.find(f => f.key === key)?.value ?? fallback;
    const extras = facts
      .filter(f => f.key.startsWith('extra:'))
      .map(f => f.value);
    const armPresets: Record<string, string> = {};
    for (const f of facts) {
      if (f.key.startsWith('arm:')) armPresets[f.key.slice('arm:'.length)] = f.value;
    }
    return {
      presetId: find('preset_id', 'octipus'),
      pronouns: find('pronouns', 'it/we'),
      tone: find('tone', 'dry'),
      narration: find('narration', 'minimal'),
      extras,
      armPresets,
    };
  }
}

let instance: PersonaProfileRepository | null = null;
export function getPersonaProfileRepository(): PersonaProfileRepository {
  if (!instance) instance = new PersonaProfileRepository();
  return instance;
}
