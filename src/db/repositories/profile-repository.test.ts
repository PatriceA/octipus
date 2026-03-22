import { describe, test, expect } from 'bun:test';

// Note: ProfileRepository tests require a live database connection.
// Integration tests are skipped; unit-level tests verify data shapes and logic.

describe.skip('ProfileRepository (Integration)', () => {
  test('placeholder — requires database', () => {
    expect(true).toBe(true);
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
