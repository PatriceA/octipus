import type { ToolManifest } from '@/core/types';
import { ProfileRepository } from '@/db/repositories/profile-repository';
import type { ProfileFact } from '@/db/schema/profiles';
import { BaseTool, createParameterSchema } from '../base-tool';

export class ProfilesTool extends BaseTool {
  readonly id = 'profiles';
  readonly name = 'People & Profiles';
  readonly version = '1.0.0';
  readonly description = 'Manage people profiles and facts — store and recall information about people, organizations, and pets the user knows.';

  private profileRepo = new ProfileRepository();

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'manage', description: 'Manage people profiles and facts', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'list_profiles', description: 'List all profiles for the current user', parameters: {}, returns: 'List of profiles' },
        { name: 'get_profile', description: 'Get a profile by ID or name', parameters: { id: { type: 'string', description: 'Profile ID' }, name: { type: 'string', description: 'Profile name' } }, returns: 'Profile details' },
        { name: 'create_profile', description: 'Create a new profile', parameters: { name: { type: 'string', description: 'Name', required: true } }, returns: 'Created profile' },
        { name: 'update_profile', description: 'Update profile fields', parameters: { id: { type: 'string', description: 'Profile ID', required: true } }, returns: 'Updated profile' },
        { name: 'add_fact', description: 'Add a fact to the profile of someone the user knows. For facts about the user themselves, prefer remember_this where available.', parameters: { id: { type: 'string', description: 'Profile ID', required: true }, key: { type: 'string', description: 'Fact key', required: true }, value: { type: 'string', description: 'Fact value', required: true } }, returns: 'Updated profile' },
        { name: 'remove_fact', description: 'Remove a fact from a profile', parameters: { id: { type: 'string', description: 'Profile ID', required: true }, key: { type: 'string', description: 'Fact key', required: true } }, returns: 'Updated profile' },
        { name: 'delete_profile', description: 'Delete a profile', parameters: { id: { type: 'string', description: 'Profile ID', required: true } }, returns: 'Deletion result' },
        { name: 'search_profiles', description: 'Search profiles by query', parameters: { query: { type: 'string', description: 'Search query', required: true } }, returns: 'Matching profiles' },
      ],
    };
  }

  private async resolveUserId(context: { userId?: string }): Promise<string> {
    if (context.userId) return context.userId;
    // Fallback: fetch the first user from the DB
    const { userRepository } = await import('@/db/repositories/user-repository');
    const users = await userRepository.listAll();
    if (users.length === 0) throw new Error('No users found');
    return users[0].id;
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'list_profiles',
      'List all profiles (people, organizations, pets) for the current user.',
      createParameterSchema({}),
      async (_args, context) => {
        const userId = await this.resolveUserId(context);
        const profilesList = await this.profileRepo.findByUserId(userId);

        if (profilesList.length === 0) {
          return { profiles: [], message: 'No profiles found. Use create_profile to add people you know.' };
        }

        return {
          profiles: profilesList.map(p => ({
            id: p.id,
            name: p.name,
            relationship: p.relationship,
            category: p.category,
            isUserProfile: p.isUserProfile,
            factCount: (p.facts as ProfileFact[])?.length || 0,
            updatedAt: p.updatedAt,
          })),
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'get_profile',
      'Get a profile by ID or name. Provide either id or name.',
      createParameterSchema({
        id: { type: 'string', description: 'Profile ID (UUID)' },
        name: { type: 'string', description: 'Profile name (fuzzy search)' },
      }),
      async (args, context) => {
        const userId = await this.resolveUserId(context);

        if (args.id) {
          const profile = await this.profileRepo.findById(args.id as string);
          if (!profile) return { error: 'Profile not found.' };
          return this.formatProfile(profile);
        }

        if (args.name) {
          const matches = await this.profileRepo.findByName(userId, args.name as string);
          if (matches.length === 0) return { error: `No profile found matching "${args.name}".` };
          if (matches.length === 1) return this.formatProfile(matches[0]);
          return {
            message: `Found ${matches.length} profiles matching "${args.name}". Be more specific or use the ID.`,
            profiles: matches.map(p => ({ id: p.id, name: p.name, relationship: p.relationship })),
          };
        }

        return { error: 'Provide either id or name.' };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'create_profile',
      'Create a new profile for a person, organization, or pet.',
      createParameterSchema({
        name: { type: 'string', description: 'Name of the person/entity', required: true },
        relationship: { type: 'string', description: 'Relationship to user (self, mother, father, friend, colleague, boss, partner, sibling, etc.)' },
        category: { type: 'string', description: 'Category: person, organization, or pet', default: 'person' },
        is_user_profile: { type: 'boolean', description: 'Set to true if this is the user\'s own profile', default: false },
      }),
      async (args, context) => {
        const userId = await this.resolveUserId(context);
        const isUserProfile = (args.is_user_profile as boolean) || false;

        // If creating a user profile, check if one already exists
        if (isUserProfile) {
          const existing = await this.profileRepo.findUserProfile(userId);
          if (existing) {
            return { error: `User profile already exists: "${existing.name}" (ID: ${existing.id}). Use update_profile instead.` };
          }
        }

        const profile = await this.profileRepo.create({
          name: args.name as string,
          relationship: (args.relationship as string) || (isUserProfile ? 'self' : undefined),
          category: (args.category as string) || 'person',
          userId,
          isUserProfile,
        });

        return { created: true, profile: this.formatProfile(profile) };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'update_profile',
      'Update profile fields (name, relationship, category).',
      createParameterSchema({
        id: { type: 'string', description: 'Profile ID', required: true },
        name: { type: 'string', description: 'New name' },
        relationship: { type: 'string', description: 'New relationship' },
        category: { type: 'string', description: 'New category' },
      }),
      async (args) => {
        const updates: Record<string, unknown> = {};
        if (args.name) updates.name = args.name;
        if (args.relationship) updates.relationship = args.relationship;
        if (args.category) updates.category = args.category;

        if (Object.keys(updates).length === 0) {
          return { error: 'No fields to update. Provide name, relationship, or category.' };
        }

        const profile = await this.profileRepo.update(args.id as string, updates);
        if (!profile) return { error: 'Profile not found.' };

        return { updated: true, profile: this.formatProfile(profile) };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'add_fact',
      // The boundary is load-bearing, not editorial. Profile facts are injected
      // only for people-related queries (see worker-spawner), while
      // `remember_this` writes to long-term memory, which is injected on EVERY
      // turn. Asked to "remember this about me", a model that picked this tool
      // stored the fact somewhere recall never looks: the next session could
      // only produce it when the user thought to say "check your stored facts".
      //
      // "prefer … when you have it", not "do not use this": `remember_this` is
      // a ROOT-only meta-tool (`createMetaTools` is called from `root-runner`
      // alone). A spawned worker holds `profiles` and no alternative, so a
      // flat prohibition would make it drop the fact entirely instead of
      // storing it in the less-visible place.
      'Add or update a fact on the profile of someone the USER KNOWS (a colleague, a family member, a contact). ' +
        'If the key already exists, it is replaced. For a fact about the USER THEMSELVES, prefer `remember_this` ' +
        'when you have it — that writes to long-term memory, which is re-read on every future turn, whereas a ' +
        'profile fact about the user is only surfaced for people-related queries.',
      createParameterSchema({
        id: { type: 'string', description: 'Profile ID', required: true },
        key: { type: 'string', description: 'Fact key (e.g., location, birthday, likes, email, phone, job, hobby)', required: true },
        value: { type: 'string', description: 'Fact value', required: true },
        source: { type: 'string', description: 'How this fact was learned (e.g., "user told us", "learned from conversation")', default: 'user told us' },
      }),
      async (args) => {
        const fact: ProfileFact = {
          key: args.key as string,
          value: args.value as string,
          source: (args.source as string) || 'user told us',
          learnedAt: new Date().toISOString(),
        };

        const profile = await this.profileRepo.addFact(args.id as string, fact);
        if (!profile) return { error: 'Profile not found.' };

        return { updated: true, profile: this.formatProfile(profile) };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'remove_fact',
      'Remove a fact from a profile by its key.',
      createParameterSchema({
        id: { type: 'string', description: 'Profile ID', required: true },
        key: { type: 'string', description: 'Fact key to remove', required: true },
      }),
      async (args) => {
        const profile = await this.profileRepo.removeFact(args.id as string, args.key as string);
        if (!profile) return { error: 'Profile not found.' };

        return { updated: true, profile: this.formatProfile(profile) };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'delete_profile',
      'Delete a profile permanently.',
      createParameterSchema({
        id: { type: 'string', description: 'Profile ID to delete', required: true },
      }),
      async (args) => {
        const deleted = await this.profileRepo.delete(args.id as string);
        if (!deleted) return { error: 'Profile not found.' };

        return { deleted: true, message: 'Profile deleted.' };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'search_profiles',
      'Search profiles by name or fact values. Use this to find people by any attribute.',
      createParameterSchema({
        query: { type: 'string', description: 'Search query (matches name and fact values)', required: true },
      }),
      async (args, context) => {
        const userId = await this.resolveUserId(context);
        const results = await this.profileRepo.search(userId, args.query as string);

        if (results.length === 0) {
          return { profiles: [], message: 'No profiles found matching the query.' };
        }

        return {
          profiles: results.map(p => ({
            id: p.id,
            name: p.name,
            relationship: p.relationship,
            category: p.category,
            facts: (p.facts as ProfileFact[])?.map(f => ({ key: f.key, value: f.value })) || [],
          })),
        };
      },
      { requiresPermission: false },
    );
  }

  private formatProfile(profile: { id: string; name: string; relationship: string | null; category: string; facts: unknown; isUserProfile: boolean | null; createdAt: Date; updatedAt: Date }) {
    const facts = (profile.facts as ProfileFact[]) || [];
    return {
      id: profile.id,
      name: profile.name,
      relationship: profile.relationship,
      category: profile.category,
      isUserProfile: profile.isUserProfile,
      facts: facts.map(f => ({ key: f.key, value: f.value, source: f.source, learnedAt: f.learnedAt })),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }
}

export const profilesTool = new ProfilesTool();
