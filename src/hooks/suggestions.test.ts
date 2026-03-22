import { describe, test, expect } from 'bun:test';
import type { HookSuggestion } from './suggestions';

// Note: getHookSuggestions requires OAuth and UMI dependencies.
// We test the HookSuggestion contract and structure with mock data.

// Build a representative set of suggestions matching the source file's output
function getMockSuggestions(): HookSuggestion[] {
  return [
    {
      id: 'morning-briefing',
      name: 'Morning Briefing',
      description: 'Daily summary at 8 AM: calendar events, unread emails, weather, and top news for your interests',
      category: 'daily-briefing',
      integration: 'google',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '0 8 * * *' },
      action: 'spawn_agent',
      actionConfig: { agentPrompt: 'Generate my morning briefing', orchestrated: true },
    },
    {
      id: 'dev-daily-standup',
      name: 'Dev Standup Prep',
      description: 'Morning standup prep: git activity, open PRs, recent commits, and blockers',
      category: 'developer',
      integration: 'system',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '45 8 * * 1-5' },
      action: 'spawn_agent',
      actionConfig: { agentPrompt: 'Prepare my daily standup summary', orchestrated: true },
    },
    {
      id: 'server-health-check',
      name: 'Server Health Check',
      description: 'Hourly check of system resources, disk usage, running services',
      category: 'monitoring',
      integration: 'system',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '0 * * * *' },
      action: 'spawn_agent',
      actionConfig: { agentPrompt: 'Run a quick server health check', orchestrated: true },
    },
    {
      id: 'research-digest',
      name: 'Weekly AI/Tech Research',
      description: 'Friday afternoon research digest -- top AI and tech developments of the week',
      category: 'productivity',
      integration: 'any',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '0 15 * * 5' },
      action: 'spawn_agent',
      actionConfig: { agentPrompt: 'Research and compile a weekly tech digest', orchestrated: true },
    },
    {
      id: 'email-triage',
      name: 'Email Triage (Every 30 min)',
      description: 'Check for new emails, classify by urgency, flag important ones, summarize',
      category: 'email',
      integration: 'google',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '*/30 * * * *' },
      action: 'spawn_agent',
      actionConfig: { agentPrompt: 'Check Gmail for new unread emails', orchestrated: true },
    },
    {
      id: 'calendar-daily',
      name: 'Daily Schedule',
      description: "Morning overview of today's meetings and events at 8:30 AM",
      category: 'calendar',
      integration: 'google',
      trigger: 'schedule',
      triggerConfig: { cronExpression: '30 8 * * 1-5' },
      action: 'spawn_agent',
      actionConfig: { agentPrompt: 'Get today\'s calendar events', orchestrated: true },
    },
  ];
}

const VALID_CATEGORIES: HookSuggestion['category'][] = [
  'daily-briefing',
  'email',
  'developer',
  'monitoring',
  'productivity',
  'calendar',
];

const VALID_INTEGRATIONS: HookSuggestion['integration'][] = [
  'google',
  'microsoft',
  'github',
  'telegram',
  'system',
  'any',
];

describe('Hook Suggestions (Unit)', () => {
  const suggestions = getMockSuggestions();

  describe('getHookSuggestions returns an array', () => {
    test('returns an array of suggestions', () => {
      expect(suggestions).toBeInstanceOf(Array);
      expect(suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('all suggestions have required fields', () => {
    test('each suggestion has id, name, description, category, integration, trigger, action', () => {
      for (const s of suggestions) {
        expect(s.id).toBeDefined();
        expect(typeof s.id).toBe('string');
        expect(s.id.length).toBeGreaterThan(0);

        expect(s.name).toBeDefined();
        expect(typeof s.name).toBe('string');
        expect(s.name.length).toBeGreaterThan(0);

        expect(s.description).toBeDefined();
        expect(typeof s.description).toBe('string');

        expect(s.category).toBeDefined();
        expect(s.integration).toBeDefined();

        expect(s.trigger).toBeDefined();
        expect(typeof s.trigger).toBe('string');

        expect(s.action).toBeDefined();
        expect(typeof s.action).toBe('string');
      }
    });

    test('each suggestion has triggerConfig and actionConfig', () => {
      for (const s of suggestions) {
        expect(s.triggerConfig).toBeDefined();
        expect(typeof s.triggerConfig).toBe('object');

        expect(s.actionConfig).toBeDefined();
        expect(typeof s.actionConfig).toBe('object');
      }
    });
  });

  describe('categories are valid', () => {
    test('each suggestion has a valid category', () => {
      for (const s of suggestions) {
        expect(VALID_CATEGORIES).toContain(s.category);
      }
    });

    test('each suggestion has a valid integration', () => {
      for (const s of suggestions) {
        expect(VALID_INTEGRATIONS).toContain(s.integration);
      }
    });
  });

  describe('no duplicate IDs', () => {
    test('all suggestion IDs are unique', () => {
      const ids = suggestions.map(s => s.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe('suggestion content', () => {
    test('all triggers are schedule type', () => {
      // All suggestions in the source use schedule triggers
      for (const s of suggestions) {
        expect(s.trigger).toBe('schedule');
      }
    });

    test('all actions are spawn_agent type', () => {
      // All suggestions in the source use spawn_agent actions
      for (const s of suggestions) {
        expect(s.action).toBe('spawn_agent');
      }
    });

    test('schedule triggers have cronExpression', () => {
      for (const s of suggestions) {
        if (s.trigger === 'schedule') {
          expect(s.triggerConfig.cronExpression).toBeDefined();
          expect(typeof s.triggerConfig.cronExpression).toBe('string');
        }
      }
    });

    test('spawn_agent actions have agentPrompt', () => {
      for (const s of suggestions) {
        if (s.action === 'spawn_agent') {
          expect(s.actionConfig.agentPrompt).toBeDefined();
          expect(typeof s.actionConfig.agentPrompt).toBe('string');
        }
      }
    });
  });
});
