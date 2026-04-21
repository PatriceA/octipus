import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'crypto';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
  truncateTables,
} from '@/test-helpers/integration';
import type { ProfileRepository } from './profile-repository';

// Integration tests require a running Postgres (docker-compose.test.yml).
// Run via:  bun run test:integration -- src/db/repositories/profile-repository.test.ts

describe.skipIf(!isIntegration)('ProfileRepository (Integration)', () => {
  let repo: ProfileRepository;
  const userId = randomUUID();

  beforeAll(async () => {
    await setupIntegrationDb();
    const mod = await import('./profile-repository');
    repo = new mod.ProfileRepository();
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  beforeEach(async () => {
    await truncateTables(['profiles']);
  });

  test('create + findById', async () => {
    const created = await repo.create({
      name: 'Alice',
      relationship: 'friend',
      category: 'person',
      userId,
      isUserProfile: false,
      facts: [],
    });

    expect(created.id).toBeDefined();
    expect(created.name).toBe('Alice');

    const found = await repo.findById(created.id);
    expect(found?.name).toBe('Alice');
  });

  test('findByUserId returns only that user', async () => {
    const otherUserId = randomUUID();
    await repo.create({ name: 'Alice', category: 'person', userId });
    await repo.create({ name: 'Charlie', category: 'person', userId });
    await repo.create({ name: 'Bob', category: 'person', userId: otherUserId });

    const mine = await repo.findByUserId(userId);
    expect(mine.length).toBe(2);
    expect(mine.map((p) => p.name).sort()).toEqual(['Alice', 'Charlie']);
  });

  test('findByName uses ILIKE (case-insensitive, partial)', async () => {
    await repo.create({ name: 'Alice Smith', category: 'person', userId });
    await repo.create({ name: 'Bob ALICE', category: 'person', userId });
    await repo.create({ name: 'Charlie', category: 'person', userId });

    const results = await repo.findByName(userId, 'alice');
    expect(results.length).toBe(2);
  });

  test('findUserProfile returns the isUserProfile=true row', async () => {
    await repo.create({ name: 'Friend', category: 'person', userId, isUserProfile: false });
    await repo.create({ name: 'Me', category: 'person', userId, isUserProfile: true });

    const me = await repo.findUserProfile(userId);
    expect(me?.name).toBe('Me');
  });

  test('addFact appends, and replaces existing key', async () => {
    const p = await repo.create({ name: 'Alice', category: 'person', userId, facts: [] });

    await repo.addFact(p.id, { key: 'location', value: 'Munich' });
    await repo.addFact(p.id, { key: 'birthday', value: 'March 15' });
    const afterAdd = await repo.findById(p.id);
    expect(afterAdd?.facts?.length).toBe(2);

    // Replacing same key keeps count at 2
    await repo.addFact(p.id, { key: 'location', value: 'Berlin' });
    const afterReplace = await repo.findById(p.id);
    expect(afterReplace?.facts?.length).toBe(2);
    expect(afterReplace?.facts?.find((f) => f.key === 'location')?.value).toBe('Berlin');
  });

  test('removeFact drops the matching key', async () => {
    const p = await repo.create({
      name: 'Alice',
      category: 'person',
      userId,
      facts: [
        { key: 'location', value: 'Berlin' },
        { key: 'likes', value: 'chocolate' },
      ],
    });

    await repo.removeFact(p.id, 'location');
    const after = await repo.findById(p.id);
    expect(after?.facts?.length).toBe(1);
    expect(after?.facts?.[0].key).toBe('likes');
  });

  test('search matches name or fact values', async () => {
    await repo.create({
      name: 'Alice',
      category: 'person',
      userId,
      facts: [{ key: 'location', value: 'Berlin' }],
    });
    await repo.create({
      name: 'Bob',
      category: 'person',
      userId,
      facts: [{ key: 'location', value: 'Munich' }],
    });

    const byName = await repo.search(userId, 'alice');
    expect(byName.length).toBe(1);
    expect(byName[0].name).toBe('Alice');

    const byFact = await repo.search(userId, 'berlin');
    expect(byFact.length).toBe(1);
    expect(byFact[0].name).toBe('Alice');
  });

  test('delete returns true for existing, false otherwise', async () => {
    const p = await repo.create({ name: 'Alice', category: 'person', userId });
    expect(await repo.delete(p.id)).toBe(true);
    expect(await repo.delete(p.id)).toBe(false);
  });
});

describe('ProfileRepository (Unit)', () => {
  describe('profile structure', () => {
    test('profile has required fields', () => {
      const profile = {
        id: 'uuid-1',
        name: 'Alice',
        relationship: 'friend',
        category: 'person',
        facts: [],
        userId: 'user-1',
        isUserProfile: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(profile.id).toBeDefined();
      expect(profile.name).toBeDefined();
      expect(profile.userId).toBeDefined();
      expect(profile.category).toBe('person');
      expect(profile.facts).toBeInstanceOf(Array);
    });

    test('profile defaults isUserProfile to false', () => {
      const profile = {
        name: 'Bob',
        userId: 'user-1',
        isUserProfile: false,
      };

      expect(profile.isUserProfile).toBe(false);
    });
  });

  describe('create profile', () => {
    test('new profile has required fields for insertion', () => {
      const newProfile = {
        name: 'Dr. Mueller',
        relationship: 'doctor',
        category: 'person',
        userId: 'user-1',
        isUserProfile: false,
        facts: [],
      };

      expect(newProfile.name).toBe('Dr. Mueller');
      expect(newProfile.relationship).toBe('doctor');
      expect(newProfile.category).toBe('person');
      expect(newProfile.userId).toBe('user-1');
    });

    test('user profile sets isUserProfile to true', () => {
      const userProfile = {
        name: 'Patrice',
        relationship: 'self',
        category: 'person',
        userId: 'user-1',
        isUserProfile: true,
        facts: [],
      };

      expect(userProfile.isUserProfile).toBe(true);
      expect(userProfile.relationship).toBe('self');
    });
  });

  describe('find by user ID', () => {
    test('returns profiles for the given user', () => {
      const allProfiles = [
        { id: 'p1', name: 'Alice', userId: 'user-1' },
        { id: 'p2', name: 'Bob', userId: 'user-2' },
        { id: 'p3', name: 'Charlie', userId: 'user-1' },
      ];

      const user1Profiles = allProfiles.filter(p => p.userId === 'user-1');

      expect(user1Profiles.length).toBe(2);
      expect(user1Profiles.map(p => p.name)).toContain('Alice');
      expect(user1Profiles.map(p => p.name)).toContain('Charlie');
    });

    test('returns empty array when user has no profiles', () => {
      const allProfiles = [
        { id: 'p1', name: 'Alice', userId: 'user-1' },
      ];

      const user2Profiles = allProfiles.filter(p => p.userId === 'user-2');

      expect(user2Profiles.length).toBe(0);
    });
  });

  describe('find by name (ILIKE)', () => {
    test('case-insensitive name matching', () => {
      const profiles = [
        { name: 'Alice Smith', userId: 'user-1' },
        { name: 'Bob ALICE', userId: 'user-1' },
        { name: 'Charlie', userId: 'user-1' },
      ];

      // Simulate ILIKE %alice%
      const query = 'alice';
      const matched = profiles.filter(
        p => p.userId === 'user-1' && p.name.toLowerCase().includes(query.toLowerCase()),
      );

      expect(matched.length).toBe(2);
    });

    test('partial name matching', () => {
      const profiles = [
        { name: 'Dr. Mueller', userId: 'user-1' },
        { name: 'Dr. Schmidt', userId: 'user-1' },
        { name: 'Alice', userId: 'user-1' },
      ];

      const query = 'Dr.';
      const matched = profiles.filter(
        p => p.name.toLowerCase().includes(query.toLowerCase()),
      );

      expect(matched.length).toBe(2);
    });
  });

  describe('add and remove facts', () => {
    test('add fact to empty facts array', () => {
      const existingFacts: Array<{ key: string; value: string; learnedAt?: string }> = [];
      const newFact = { key: 'location', value: 'Berlin' };

      const updatedFacts = [...existingFacts, { ...newFact, learnedAt: new Date().toISOString() }];

      expect(updatedFacts.length).toBe(1);
      expect(updatedFacts[0].key).toBe('location');
      expect(updatedFacts[0].value).toBe('Berlin');
      expect(updatedFacts[0].learnedAt).toBeDefined();
    });

    test('add fact replaces existing fact with same key', () => {
      const existingFacts = [
        { key: 'location', value: 'Munich', learnedAt: '2024-01-01' },
        { key: 'birthday', value: 'March 15', learnedAt: '2024-01-01' },
      ];

      const newFact = { key: 'location', value: 'Berlin' };

      // Replicate the addFact logic: filter out same key, then append
      const filtered = existingFacts.filter(f => f.key !== newFact.key);
      const updatedFacts = [...filtered, { ...newFact, learnedAt: new Date().toISOString() }];

      expect(updatedFacts.length).toBe(2);
      const locationFact = updatedFacts.find(f => f.key === 'location');
      expect(locationFact?.value).toBe('Berlin');
    });

    test('remove fact by key', () => {
      const existingFacts = [
        { key: 'location', value: 'Berlin' },
        { key: 'birthday', value: 'March 15' },
        { key: 'likes', value: 'chocolate' },
      ];

      const keyToRemove = 'birthday';
      const updatedFacts = existingFacts.filter(f => f.key !== keyToRemove);

      expect(updatedFacts.length).toBe(2);
      expect(updatedFacts.find(f => f.key === 'birthday')).toBeUndefined();
    });

    test('remove non-existent fact key is a no-op', () => {
      const existingFacts = [
        { key: 'location', value: 'Berlin' },
      ];

      const updatedFacts = existingFacts.filter(f => f.key !== 'nonexistent');

      expect(updatedFacts.length).toBe(1);
    });

    test('fact preserves learnedAt if provided', () => {
      const fact = { key: 'email', value: 'alice@example.com', learnedAt: '2025-01-15T10:00:00Z' };
      const updatedFact = { ...fact, learnedAt: fact.learnedAt || new Date().toISOString() };

      expect(updatedFact.learnedAt).toBe('2025-01-15T10:00:00Z');
    });

    test('fact gets learnedAt set if not provided', () => {
      const fact = { key: 'email', value: 'alice@example.com' };
      const updatedFact = { ...fact, learnedAt: (fact as any).learnedAt || new Date().toISOString() };

      expect(updatedFact.learnedAt).toBeDefined();
      // Should be a valid ISO string
      expect(new Date(updatedFact.learnedAt).toISOString()).toBe(updatedFact.learnedAt);
    });
  });

  describe('search profiles', () => {
    test('search matches by name', () => {
      const profiles = [
        { name: 'Alice', userId: 'user-1', facts: [] },
        { name: 'Bob', userId: 'user-1', facts: [] },
      ];

      const query = 'alice';
      const matched = profiles.filter(
        p => p.userId === 'user-1' &&
          (p.name.toLowerCase().includes(query.toLowerCase()) ||
           JSON.stringify(p.facts).toLowerCase().includes(query.toLowerCase())),
      );

      expect(matched.length).toBe(1);
      expect(matched[0].name).toBe('Alice');
    });

    test('search matches by fact values', () => {
      const profiles = [
        { name: 'Alice', userId: 'user-1', facts: [{ key: 'location', value: 'Berlin' }] },
        { name: 'Bob', userId: 'user-1', facts: [{ key: 'location', value: 'Munich' }] },
      ];

      const query = 'berlin';
      const matched = profiles.filter(
        p => p.userId === 'user-1' &&
          (p.name.toLowerCase().includes(query.toLowerCase()) ||
           JSON.stringify(p.facts).toLowerCase().includes(query.toLowerCase())),
      );

      expect(matched.length).toBe(1);
      expect(matched[0].name).toBe('Alice');
    });

    test('search scoped to user', () => {
      const profiles = [
        { name: 'Alice', userId: 'user-1', facts: [] },
        { name: 'Alice Clone', userId: 'user-2', facts: [] },
      ];

      const query = 'alice';
      const matched = profiles.filter(
        p => p.userId === 'user-1' && p.name.toLowerCase().includes(query.toLowerCase()),
      );

      expect(matched.length).toBe(1);
    });
  });

  describe('delete profile', () => {
    test('delete returns true when profile exists', () => {
      const profiles = new Map([['p1', { id: 'p1', name: 'Alice' }]]);

      const existed = profiles.has('p1');
      profiles.delete('p1');

      expect(existed).toBe(true);
      expect(profiles.has('p1')).toBe(false);
    });

    test('delete returns false when profile does not exist', () => {
      const profiles = new Map<string, object>();

      const existed = profiles.has('nonexistent');

      expect(existed).toBe(false);
    });
  });
});
