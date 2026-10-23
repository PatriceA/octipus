import { describe, expect, test } from 'vitest';
import { buildPlan, slugify, standingInstructions } from './plan';
import { initialAnswers, sectionsFor, storableAnswers, visibleQuestions } from './use-cases';
import type { Answers, OnboardingState, PlanStep, UseCaseId } from './types';

/** A fresh install as its admin sees it. */
const fresh = (over: Partial<OnboardingState> = {}): OnboardingState => ({
  isAdmin: true,
  setupComplete: false,
  models: { textReady: false, embeddingReady: false, verifySeparate: false, names: [], providersWithKey: [], byTopic: {} },
  cliTools: [
    { name: 'Claude Code', modelId: 'cli/claude-code', available: true },
    { name: 'Codex', modelId: 'cli/codex', available: false },
  ],
  ollama: { url: 'http://localhost:11434', reachable: false },
  workspaces: [{ id: 'w1', name: 'Personal', slug: 'personal', kind: 'personal', isDefault: true }],
  mailbox: null,
  oauthClients: { google: true, microsoft: false },
  connectors: [{ id: 'atlassian', name: 'Atlassian', connected: false }, { id: 'linear', name: 'Linear', connected: false }],
  channels: { configured: [], linked: [] },
  heartbeat: { serverEnabled: false, enabled: false, watchEmail: false, intervalMinutes: null, timezone: 'UTC' },
  permissions: { tasksWrite: 'ASK', messagingSend: 'ASK' },
  standingInstructions: false,
  roleAgents: [],
  pipelineTemplates: [{ id: 'tpl-dev', name: 'Full Development Cycle' }, { id: 'tpl-research', name: 'Research & Analysis' }],
  mcpServers: [],
  workspaceRoot: null,
  modules: { enabled: [], byUseCase: { company: [{ id: 'business', title: 'Cases' }, { id: 'mail', title: 'Mail' }] } },
  progress: {},
  ...over,
});

const plan = (useCases: UseCaseId[], answers: Answers, state = fresh()) =>
  buildPlan(useCases, { ...initialAnswers(useCases, state), ...answers }, state, { newPassword: () => 'Pw-123456' });
const ids = (steps: PlanStep[]) => steps.map((s) => s.id);
/** What will actually be done (not what was found already in place). */
const todo = (steps: PlanStep[]) => steps.filter((s) => s.kind !== 'done').map((s) => s.id);
const found = (steps: PlanStep[]) => steps.filter((s) => s.kind === 'done').map((s) => s.id);
const step = (steps: PlanStep[], id: string) => steps.find((s) => s.id === id);

describe('models', () => {
  test('an API key: store it, add the model, use it everywhere, test it, then the separate checker', () => {
    const steps = plan(['development'], {
      'models.source': 'key', 'models.provider': 'anthropic', 'models.key': 'sk-ant', 'models.modelId': 'claude-sonnet-5-5',
      'models.verify': true, 'models.verifyModelId': 'claude-opus-5-5',
    });
    expect(ids(steps).slice(0, 6)).toEqual([
      'key:main', 'model:anthropic claude-sonnet-5-5', 'assign-all', 'test:main', 'model:anthropic claude-opus-5-5', 'bind:verify',
    ]);
    expect(step(steps, 'key:main')).toMatchObject({ secret: true, call: { path: '/settings/batch', body: { settings: { 'anthropic.apiKey': 'sk-ant' } } } });
    expect(step(steps, 'assign-all')).toMatchObject({ call: { body: { model: 'anthropic claude-sonnet-5-5' } }, dependsOn: ['model:anthropic claude-sonnet-5-5'] });
    expect(step(steps, 'bind:verify')).toMatchObject({ dependsOn: ['model:anthropic claude-opus-5-5', 'assign-all'] });
    expect(step(steps, 'test:main')).toMatchObject({ optional: true });
  });

  test('what exists is not added again but listed as already set up; "keep" changes nothing', () => {
    const state = fresh({
      models: { textReady: true, embeddingReady: true, verifySeparate: false, names: ['anthropic claude-sonnet-5-5'], providersWithKey: ['anthropic'], byTopic: {} },
    });
    expect(initialAnswers(['research'], state)['models.source']).toBe('keep');
    const kept = plan(['research'], {}, state);
    expect(todo(kept).some((id) => id.startsWith('model:') || id === 'assign-all')).toBe(false);
    expect(found(kept)).toEqual(expect.arrayContaining(['models:ready', 'models:embedding']));
    const again = plan(['research'], { 'models.source': 'key', 'models.provider': 'anthropic', 'models.modelId': 'claude-sonnet-5-5' }, state);
    expect(found(again)).toContain('model:anthropic claude-sonnet-5-5');
    expect(step(again, 'model:anthropic claude-sonnet-5-5')?.title).toBe('The model "anthropic claude-sonnet-5-5" is already added');
    expect(ids(again)).not.toContain('key:main'); // an empty key keeps the stored one
    expect(todo(again)).toContain('assign-all');
  });

  test('a CLI subscription becomes the model', () => {
    const steps = plan(['company'], { 'models.source': 'cli', 'models.cliTool': 'cli/claude-code' });
    expect(step(steps, 'model:Claude Code CLI')).toMatchObject({ call: { body: { provider: 'cli', modelId: 'cli/claude-code' } } });
    expect(step(steps, 'assign-all')).toMatchObject({ call: { body: { model: 'Claude Code CLI' } } });
  });

  test('document search with Ollama binds the embedding lane', () => {
    const steps = plan(['research'], { 'models.source': 'keep', 'models.embedding': 'ollama', 'models.ollamaUrl': 'http://gpu:11434' });
    expect(ids(steps).slice(0, 3)).toEqual(['setting:ollama.url', 'model:ollama nomic-embed-text', 'bind:embedding']);
    expect(step(steps, 'model:ollama nomic-embed-text')).toMatchObject({ call: { body: { endpoint: 'http://gpu:11434' } } });
  });

  test('someone who is not an admin is never planned an install-wide change', () => {
    const state = fresh({ isAdmin: false });
    expect(visibleQuestions(sectionsFor(['company'])[0], {}, state)).toEqual([]);
    const steps = plan(['company', 'development'], { 'models.source': 'key', 'models.provider': 'openai', 'models.key': 'k', 'dev.root': '/home/x' }, state);
    expect(steps.some((s) => s.kind === 'api' && /^\/(models|topics|settings|workspace|mcp|admin)/.test(s.call.path))).toBe(false);
    expect(ids(steps)).toContain('todo:heartbeat');
  });
});

describe('areas of work', () => {
  test('new areas become personal workspaces; existing ones are left alone', () => {
    const steps = plan(['company'], { 'areas.separate': true, 'areas.names': ['Acme Ltd', 'Personal', 'Café Noir', 'Acme Ltd'] });
    expect(todo(steps).filter((id) => id.startsWith('area:'))).toEqual(['area:acme-ltd', 'area:cafe-noir']);
    expect(step(steps, 'area:personal')).toMatchObject({ kind: 'done', title: 'The area "Personal" already exists' });
    expect(step(steps, 'area:cafe-noir')).toMatchObject({ call: { path: '/me/workspaces', body: { slug: 'cafe-noir', name: 'Café Noir' } } });
  });

  test('a team gets a shared space', () => {
    expect(step(plan(['product'], { 'areas.team': true, 'areas.spaceName': 'Acme team' }), 'space')).toMatchObject({ call: { path: '/spaces', body: { name: 'Acme team' } } });
  });

  test('companies with their own mailbox get their own login, with the password shown once', () => {
    const steps = plan(['company'], { 'areas.separate': true, 'areas.names': ['A', 'B'], 'areas.logins': true, 'areas.loginNames': 'acme\nBeta Co' });
    expect(step(steps, 'login:acme')).toMatchObject({ secret: true, call: { path: '/admin/users', body: { username: 'acme', password: 'Pw-123456' } } });
    expect(step(steps, 'login:betaco')).toBeDefined();
    expect((step(steps, 'login:acme') as { reveal?: string }).reveal).toContain('Pw-123456');
  });

  test('slugify', () => {
    expect(slugify('  Ünïcode & Co. GmbH  ')).toBe('unicode-co-gmbh');
    // Nothing usable left: a stable name per input, so two such areas do not collide.
    expect(slugify('!!!')).toMatch(/^area-[a-z0-9]+$/);
    expect(slugify('!!!')).toBe(slugify('!!!'));
    expect(slugify('東京')).not.toBe(slugify('大阪'));
    expect(slugify('x'.repeat(50))).toHaveLength(32);
    // Cut first, then trimmed: no dash left at the end.
    expect(slugify(`${'a'.repeat(31)} b`)).toBe('a'.repeat(31));
  });
});

describe('chat', () => {
  test('Telegram: start the bot, then link with the code it sends', () => {
    const steps = plan(['company'], { 'chat.channel': 'telegram', 'chat.telegramToken': '123:abc' });
    expect(step(steps, 'setting:telegram.botToken')).toMatchObject({ secret: true, call: { path: '/settings/telegram.botToken', body: { value: '123:abc' } } });
    expect(step(steps, 'link:telegram')).toMatchObject({ kind: 'code', call: { path: '/auth/link', field: 'code' }, dependsOn: ['setting:telegram.botToken'] });
  });

  test('an already linked chat needs nothing; another platform points to its settings', () => {
    expect(step(plan(['company'], { 'chat.channel': 'telegram' }, fresh({ channels: { configured: ['telegram'], linked: ['telegram'] } })), 'link:telegram'))
      .toMatchObject({ kind: 'done', title: 'Your Telegram chat is already linked' });
    expect(step(plan(['company'], { 'chat.channel': 'slack' }), 'todo:channel:slack')).toMatchObject({ kind: 'todo', href: '/settings' });
  });
});

describe('software development', () => {
  test('coding CLIs, the repositories folder, Jira, and a coding agent through the dev pipeline', () => {
    const steps = plan(['development'], {
      'models.source': 'keep', 'dev.cli': ['cli/claude-code', 'cli/codex'], 'dev.cliForBuild': true, 'dev.root': '/home/me/code',
      'dev.githubToken': 'ghp_x', 'tools.tracker': 'jira', 'dev.roleAgent': true,
    });
    // Codex is not installed: not added.
    expect(ids(steps)).toEqual(expect.arrayContaining(['model:Claude Code CLI', 'bind:build', 'workspace-root', 'vault:github_token', 'connect:atlassian',
      'setting:heartbeat.enabled', 'perm:tasks/write', 'role:coding']));
    expect(ids(steps)).not.toContain('model:Codex CLI');
    expect(step(steps, 'role:coding')).toMatchObject({ call: { body: { role: 'coding', enabled: true, pipelineTemplate: 'tpl-dev' } } });
    expect(step(steps, 'connect:atlassian')).toMatchObject({ kind: 'connect', start: { method: 'POST', path: '/connectors/atlassian/authorize' } });
  });

  test('the coding lane is bound after "use it for all work", which would overwrite it', () => {
    const steps = plan(['development'], { 'models.source': 'key', 'models.provider': 'openai', 'models.modelId': 'gpt-x', 'dev.cli': ['cli/claude-code'], 'dev.cliForBuild': true });
    expect(ids(steps).indexOf('bind:build')).toBeGreaterThan(ids(steps).indexOf('assign-all'));
    expect(step(steps, 'bind:build')?.dependsOn).toEqual(['model:Claude Code CLI', 'assign-all']);
  });

  test('another tracker by its MCP address (admins)', () => {
    const steps = plan(['development'], { 'tools.tracker': 'mcp', 'tools.mcpName': 'youtrack', 'tools.mcpUrl': 'https://yt.example.com/mcp' });
    expect(step(steps, 'mcp:youtrack')).toMatchObject({ call: { path: '/mcp/servers', body: { transport: 'streamable-http', sseUrl: 'https://yt.example.com/mcp' } } });
  });

  test('an agent already on the same way is not touched', () => {
    const state = fresh({ roleAgents: [{ role: 'coding', enabled: true, pipelineTemplate: 'tpl-dev' }], heartbeat: { ...fresh().heartbeat, serverEnabled: true }, permissions: { tasksWrite: 'ALLOW', messagingSend: 'ASK' } });
    const steps = plan(['development'], { 'dev.roleAgent': true, 'dev.pipeline': 'tpl-dev' }, state);
    expect(todo(steps).filter((id) => /^(role|perm|setting:heartbeat)/.test(id))).toEqual([]);
    expect(step(steps, 'role:coding')).toMatchObject({ kind: 'done' });
  });
});

describe('running a company', () => {
  const answers = {
    'company.name': 'Acme Design', 'company.about': 'A three-person design studio.', 'company.mail': true, 'mailbox.provider': 'google',
    'company.urgent': 'the bank\nclient complaints', 'company.send': 'draft', 'company.interval': '30', 'company.ideas': true,
  };

  test('mailbox, inbox watch, permissions, instructions and an idea agent', () => {
    const steps = plan(['company'], answers);
    expect(ids(steps)).toEqual(expect.arrayContaining(['standing-instructions', 'connect:mailbox', 'setting:heartbeat.enabled', 'perm:tasks/write',
      'perm:messaging/send', 'heartbeat:me', 'role:general', 'setup-complete']));
    expect(step(steps, 'connect:mailbox')).toMatchObject({ start: { path: '/auth/oauth/google/authorize' }, doneWhen: { mailbox: true } });
    expect(step(steps, 'heartbeat:me')).toMatchObject({ call: { body: { enabled: true, watchEmail: true, intervalMinutes: 30 } }, dependsOn: ['connect:mailbox'] });
    expect(step(steps, 'role:general')).toMatchObject({ call: { body: { pipelineTemplate: 'tpl-research' } } });
  });

  test('without a sign-in client for the mailbox, the admin is sent to add one first', () => {
    const steps = plan(['company'], { ...answers, 'mailbox.provider': 'microsoft' });
    expect(step(steps, 'todo:oauth-client:microsoft')).toMatchObject({ kind: 'todo', href: '/secrets' });
    expect(ids(steps)).not.toContain('connect:mailbox');
  });

  test('the standing instructions say what the person said, and never to send unless allowed', () => {
    const text = standingInstructions({ ...answers, _useCases: ['company'] });
    expect(text).toContain('About Acme Design: A three-person design studio.');
    expect(text).toContain('Tell me right away (send_to_user) about: the bank; client complaints');
    expect(text).toContain('Never send email');
    expect(standingInstructions({ ...answers, 'company.send': 'send' })).toContain('Routine replies may be sent');
  });
});

describe('already set up before the guide', () => {
  test('a connected mailbox, an inbox already watched, Jira already connected and allowed permissions are all listed as done', () => {
    const state = fresh({
      mailbox: 'google',
      connectors: [{ id: 'atlassian', name: 'Atlassian', connected: true }],
      heartbeat: { serverEnabled: true, enabled: true, watchEmail: true, intervalMinutes: 15, timezone: 'UTC' },
      permissions: { tasksWrite: 'ALLOW', messagingSend: 'ALLOW' },
      workspaceRoot: '/home/me/code',
    });
    const steps = plan(['company', 'development'], {
      'company.mail': true, 'company.interval': '15', 'tools.tracker': 'jira', 'dev.root': '/home/me/code', 'company.ideas': false, 'dev.roleAgent': false,
    }, state);
    expect(found(steps)).toEqual(expect.arrayContaining([
      'connect:mailbox', 'heartbeat:me', 'connect:atlassian', 'perm:tasks/write', 'perm:messaging/send', 'setting:heartbeat.enabled', 'workspace-root',
    ]));
    expect(steps.filter((s) => s.kind === 'connect')).toEqual([]);
  });

  test('a done step counts as done for the steps after it', () => {
    const steps = plan(['company'], { 'company.mail': true, 'company.interval': '30' }, fresh({ mailbox: 'google' }));
    expect(step(steps, 'heartbeat:me')).toMatchObject({ kind: 'api', dependsOn: ['connect:mailbox'] });
    expect(step(steps, 'connect:mailbox')).toMatchObject({ kind: 'done' });
  });
});

describe('answers', () => {
  test('secrets are never kept with the saved answers', () => {
    expect(storableAnswers({ 'models.key': 'sk', 'models.provider': 'openai', 'chat.telegramToken': 't', 'dev.githubToken': 'g', 'company.name': 'A' }))
      .toEqual({ 'models.provider': 'openai', 'company.name': 'A' });
  });

  test('questions of a use case not chosen are not asked or planned', () => {
    expect(sectionsFor(['research']).map((s) => s.id)).toEqual(['models', 'areas', 'chat', 'research']);
    expect(ids(plan(['research'], { 'dev.roleAgent': true, 'company.mail': true }))).not.toContain('role:coding');
  });

  test('an install already set up is not marked again', () => {
    expect(ids(plan(['research'], {}, fresh({ setupComplete: true })))).not.toContain('setup-complete');
  });
});

describe('modules', () => {
  test('development: the core only, no module step', () => {
    expect(ids(plan(['development'], {}))).not.toContain('modules');
  });

  test('company turns on its modules first, before any step that may use them', () => {
    const steps = plan(['company'], {});
    expect(steps[0]).toMatchObject({ id: 'modules', kind: 'api', call: { method: 'POST', path: '/modules/enable', body: { ids: ['business', 'mail'] } } });
  });

  test('only what is missing is turned on; nothing is ever turned off', () => {
    const some = plan(['company'], {}, fresh({ modules: { enabled: ['mail', 'research'], byUseCase: fresh().modules.byUseCase } }));
    expect(step(some, 'modules')).toMatchObject({ call: { body: { ids: ['business'] } } });
    const all = plan(['company'], {}, fresh({ modules: { enabled: ['business', 'mail'], byUseCase: fresh().modules.byUseCase } }));
    expect(found(all)).toContain('modules');
    expect(todo(all)).not.toContain('modules');
  });

  test('someone who is not an admin is told who turns them on; nothing is called', () => {
    const steps = plan(['company'], {}, fresh({ isAdmin: false }));
    expect(step(steps, 'modules')).toMatchObject({ kind: 'done', title: expect.stringMatching(/Your admin turns on Cases, Mail/) });
  });

  test('a server that reports no modules: no step', () => {
    expect(ids(plan(['company'], {}, fresh({ modules: undefined as never })))).not.toContain('modules');
  });
});
