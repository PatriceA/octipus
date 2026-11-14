import { describe, expect, test } from 'vitest';
import { buildPlan, defaultModulesFor, MODULES_PICKED, requiredModulesFor, slugify, standingInstructions } from './plan';
import { initialAnswers, modelSetupProblem, sectionsFor, storableAnswers, visibleQuestions } from './use-cases';
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
  channels: { configured: [], linked: [] },
  heartbeat: { serverEnabled: false, enabled: false, watchEmail: false, intervalMinutes: null, timezone: 'UTC' },
  permissions: { tasksWrite: 'ASK', messagingSend: 'ASK' },
  standingInstructions: false,
  roleAgents: [],
  pipelineTemplates: [{ id: 'tpl-dev', name: 'Full Development Cycle' }, { id: 'tpl-research', name: 'Research & Analysis' }],
  mcpServers: [],
  workspaceRoot: null,
  // The inbox is on already (an install from before modules has every module).
  modules: { enabled: ['inbox', 'channels'], byUseCase: { company: [{ id: 'business', title: 'Cases' }, { id: 'mail', title: 'Mail' }] } },
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
      'key:main', 'model:anthropic claude-sonnet-5-5', 'test:main', 'assign-all', 'model:anthropic claude-opus-5-5', 'bind:verify',
    ]);
    expect(step(steps, 'key:main')).toMatchObject({ secret: true, call: { path: '/settings/batch', body: { settings: { 'anthropic.apiKey': 'sk-ant' } } } });
    expect(step(steps, 'assign-all')).toMatchObject({ call: { body: { model: 'anthropic claude-sonnet-5-5' } }, dependsOn: ['test:main'] });
    expect(step(steps, 'bind:verify')).toMatchObject({ dependsOn: ['model:anthropic claude-opus-5-5', 'assign-all'] });
    expect(step(steps, 'test:main')).toMatchObject({ dependsOn: ['model:anthropic claude-sonnet-5-5', 'key:main'] });
    expect(step(steps, 'setup-complete')?.dependsOn).toContain('test:main');
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
  test('coding CLIs, the repositories folder, GitHub issues, and a coding agent through the dev pipeline', () => {
    const steps = plan(['development'], {
      'models.source': 'keep', 'dev.cli': ['cli/claude-code', 'cli/codex'], 'dev.cliForBuild': true, 'dev.root': '/home/me/code',
      'dev.githubToken': 'ghp_x', 'tools.tracker': 'github', 'dev.roleAgent': true,
    });
    // Codex is not installed: not added.
    expect(ids(steps)).toEqual(expect.arrayContaining(['model:Claude Code CLI', 'bind:build', 'workspace-root', 'vault:github_token',
      'setting:heartbeat.enabled', 'perm:tasks/write', 'role:coding']));
    expect(ids(steps)).not.toContain('model:Codex CLI');
    expect(step(steps, 'role:coding')).toMatchObject({ call: { body: { role: 'coding', enabled: true, pipelineTemplate: 'tpl-dev' } } });
    // GitHub issues go through the GitHub tool: nothing to connect.
    expect(steps.filter((s) => s.kind === 'connect')).toEqual([]);
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

  test('a tracker answer saved before Jira and Linear were removed plans nothing', () => {
    for (const tracker of ['jira', 'linear']) {
      const steps = plan(['development'], { 'tools.tracker': tracker });
      expect(ids(steps).filter((id) => id.startsWith('connect:') || id.startsWith('mcp:'))).toEqual([]);
    }
  });

  test('the tracker question offers GitHub, an MCP server (admins) and none', async () => {
    const { SECTIONS } = await import('./use-cases');
    const question = SECTIONS.find((s) => s.id === 'tools')!.questions.find((q) => q.id === 'tools.tracker')!;
    const values = (isAdmin: boolean) => (question.options as (s: OnboardingState, a: Answers) => Array<{ value: string }>)(fresh({ isAdmin }), {}).map((o) => o.value);
    expect(values(true)).toEqual(['github', 'mcp', 'none']);
    expect(values(false)).toEqual(['github', 'none']);
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
    expect(step(steps, 'heartbeat:me')).toMatchObject({ call: { body: { enabled: true, watchEmail: true, intervalMinutes: 30 } }, dependsOn: ['connect:mailbox', 'modules'] });
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
  test('a connected mailbox, an inbox already watched and allowed permissions are all listed as done', () => {
    const state = fresh({
      mailbox: 'google',
      heartbeat: { serverEnabled: true, enabled: true, watchEmail: true, intervalMinutes: 15, timezone: 'UTC' },
      permissions: { tasksWrite: 'ALLOW', messagingSend: 'ALLOW' },
      workspaceRoot: '/home/me/code',
    });
    const steps = plan(['company', 'development'], {
      'company.mail': true, 'company.interval': '15', 'tools.tracker': 'github', 'dev.root': '/home/me/code', 'company.ideas': false, 'dev.roleAgent': false,
    }, state);
    expect(found(steps)).toEqual(expect.arrayContaining([
      'connect:mailbox', 'heartbeat:me', 'perm:tasks/write', 'perm:messaging/send', 'setting:heartbeat.enabled', 'workspace-root',
    ]));
    expect(steps.filter((s) => s.kind === 'connect')).toEqual([]);
  });

  test('a done step counts as done for the steps after it', () => {
    const steps = plan(['company'], { 'company.mail': true, 'company.interval': '30' }, fresh({ mailbox: 'google' }));
    expect(step(steps, 'heartbeat:me')).toMatchObject({ kind: 'api', dependsOn: ['connect:mailbox', 'modules'] });
    expect(step(steps, 'connect:mailbox')).toMatchObject({ kind: 'done' });
  });
});

describe('answers', () => {
  test('secrets are never kept with the saved answers', () => {
    expect(storableAnswers({ 'models.key': 'sk', 'models.provider': 'openai', 'chat.telegramToken': 't', 'dev.githubToken': 'g', 'company.name': 'A' }))
      .toEqual({ 'models.provider': 'openai', 'company.name': 'A' });
  });

  test('questions of a use case not chosen are not asked or planned', () => {
    expect(sectionsFor(['research']).map((s) => s.id)).toEqual(['models', 'areas', 'chat', 'media', 'research']);
    expect(ids(plan(['research'], { 'dev.roleAgent': true, 'company.mail': true }))).not.toContain('role:coding');
  });

  test('an install already set up is not marked again', () => {
    expect(ids(plan(['research'], {}, fresh({ setupComplete: true })))).not.toContain('setup-complete');
  });
});

describe('images and audio', () => {
  const keyed = (providers: string[]) => fresh({ models: { ...fresh().models, providersWithKey: providers } });
  const media = (steps: PlanStep[]) => ids(steps).filter((id) => /image_generation|image-1|flash-image|^voice:|^key:(openai|gemini|mistral)$|^todo:key:/.test(id));

  test('skipped by default: nothing is added or bound, and no Voice module is asked for', () => {
    const answers = initialAnswers(['development'], fresh());
    expect(answers).toMatchObject({ 'media.images': false, 'media.voice': 'skip' });
    const steps = plan(['development'], {});
    expect(media(steps)).toEqual([]);
    expect(requiredModulesFor(['development'], answers)).not.toContain('voice');
  });

  test('generate images: the chosen provider\'s model is added and bound to the Image generation lane', () => {
    const steps = plan(['development'], { 'media.images': true, 'media.imageProvider': 'gemini' }, keyed(['gemini']));
    expect(step(steps, 'model:gemini gemini-2.5-flash-image')).toMatchObject({
      kind: 'api', call: { method: 'POST', path: '/models', body: { name: 'gemini gemini-2.5-flash-image', provider: 'gemini', modelId: 'gemini-2.5-flash-image', supportsTools: false } },
    });
    expect(step(steps, 'bind:image_generation')).toMatchObject({
      call: { method: 'PUT', path: '/topics/image_generation/binding', body: { primaryModel: 'gemini gemini-2.5-flash-image' } },
      dependsOn: ['model:gemini gemini-2.5-flash-image'],
    });
  });

  test('the image key: from this answer, from the model step, or a to-do while the lane stays unbound', () => {
    const entered = plan(['development'], { 'media.images': true, 'media.imageProvider': 'openai', 'media.imageKey': 'sk-img' });
    expect(step(entered, 'key:openai')).toMatchObject({ secret: true, call: { body: { settings: { 'openai.apiKey': 'sk-img' } } } });
    expect(step(entered, 'model:openai gpt-image-1')?.dependsOn).toEqual(['key:openai']);
    const fromModels = plan(['development'], { 'models.source': 'key', 'models.provider': 'openai', 'models.key': 'sk-main', 'models.modelId': 'gpt-4o-mini', 'media.images': true, 'media.imageProvider': 'openai' });
    expect(step(fromModels, 'model:openai gpt-image-1')?.dependsOn).toEqual(['key:main']);
    const missing = plan(['development'], { 'media.images': true, 'media.imageProvider': 'openai' });
    expect(step(missing, 'todo:key:openai')).toMatchObject({ kind: 'todo', href: '/secrets' });
    expect(ids(missing)).not.toContain('bind:image_generation');
  });

  test('a lane already on that model is listed as done', () => {
    const state = fresh({ models: { ...fresh().models, providersWithKey: ['openai'], names: ['openai gpt-image-1'], byTopic: { image_generation: 'openai gpt-image-1' } } });
    const steps = plan(['development'], { 'media.images': true, 'media.imageProvider': 'openai' }, state);
    expect(found(steps)).toEqual(expect.arrayContaining(['model:openai gpt-image-1', 'bind:image_generation']));
  });

  test('local voice: faster-whisper and Kokoro from the speech catalog, after the Voice module is on', () => {
    const steps = plan(['development'], { 'media.voice': 'local' }, fresh({ modules: { enabled: [], byUseCase: {} } }));
    expect(step(steps, 'modules')).toMatchObject({ call: { body: { ids: ['voice'] } } });
    expect(step(steps, 'voice:stt')).toMatchObject({ call: { method: 'POST', path: '/voice/engines/use', body: { direction: 'stt', engine: 'fasterwhisper', size: 'small', makePrimary: true } }, dependsOn: ['modules'] });
    expect(step(steps, 'voice:tts')).toMatchObject({ call: { body: { direction: 'tts', engine: 'kokoro', makePrimary: true } }, dependsOn: ['modules'] });
    expect(requiredModulesFor(['development'], { 'media.voice': 'local' })).toContain('voice');
  });

  test('cloud voice: the provider\'s engines, with its key; a key entered for images serves both', () => {
    const steps = plan(['development'], { 'media.voice': 'cloud', 'media.voiceProvider': 'mistral' }, keyed(['mistral']));
    expect(step(steps, 'voice:stt')).toMatchObject({ call: { body: { direction: 'stt', engine: 'mistral' } } });
    expect(step(steps, 'voice:tts')).toMatchObject({ call: { body: { direction: 'tts', engine: 'mistral' } } });
    const shared = plan(['development'], { 'media.images': true, 'media.imageProvider': 'openai', 'media.imageKey': 'sk-1', 'media.voice': 'cloud', 'media.voiceProvider': 'openai' });
    expect(step(shared, 'voice:tts')?.dependsOn).toEqual(expect.arrayContaining(['key:openai']));
    expect(ids(shared).filter((id) => id === 'key:openai')).toHaveLength(1);
    const missing = plan(['development'], { 'media.voice': 'cloud', 'media.voiceProvider': 'openai' });
    expect(ids(missing)).toContain('todo:key:openai');
    expect(ids(missing)).not.toContain('voice:stt');
  });

  test('someone who is not an admin is never planned a media change', () => {
    const steps = plan(['development'], { 'media.images': true, 'media.imageProvider': 'openai', 'media.voice': 'local' }, fresh({ isAdmin: false, models: { ...fresh().models, providersWithKey: ['openai'] } }));
    expect(media(steps)).toEqual([]);
  });

  test('basic mode never asks or plans it', () => {
    expect(sectionsFor([], true).map((s) => s.id)).not.toContain('media');
    const steps = plan([], { _basicsOnly: true, 'models.source': 'cli', 'models.cliTool': 'cli/claude-code', 'media.images': true, 'media.imageProvider': 'openai', 'media.voice': 'local' }, keyed(['openai']));
    expect(media(steps)).toEqual([]);
  });
});

describe('modules', () => {
  test('research offers no Reader and no research plugin: they are the example plugins, not product features', () => {
    const steps = plan(['research'], { 'research.roleAgent': true });
    expect(ids(steps)).not.toContain('plugin:reader');
    expect(ids(steps)).not.toContain('plugin:research');
    expect(steps.map((s) => s.title).join('\n')).not.toMatch(/reader|research jobs|plugin/i);
  });

  test('development: the core only, no module step', () => {
    expect(ids(plan(['development'], {}))).not.toContain('modules');
  });

  test('company turns on its modules first, before any step that may use them', () => {
    const steps = plan(['company'], {});
    expect(steps[0]).toMatchObject({ id: 'modules', kind: 'api', call: { method: 'POST', path: '/modules/enable', body: { ids: ['business', 'mail'] } } });
  });

  test('only what is missing is turned on; nothing is ever turned off', () => {
    const some = plan(['company'], { 'company.mail': false }, fresh({ modules: { enabled: ['mail', 'recall'], byUseCase: fresh().modules.byUseCase } }));
    expect(step(some, 'modules')).toMatchObject({ call: { body: { ids: ['business'] } } });
    const all = plan(['company'], { 'company.mail': false }, fresh({ modules: { enabled: ['business', 'mail'], byUseCase: fresh().modules.byUseCase } }));
    expect(found(all)).toContain('modules');
    expect(todo(all)).not.toContain('modules');
  });

  test('a chat picked to talk from turns on the chat channels', () => {
    const steps = plan(['development'], { 'chat.channel': 'telegram' }, fresh({ modules: { enabled: [], byUseCase: {} } }));
    expect(step(steps, 'modules')).toMatchObject({ call: { body: { ids: ['channels'] } } });
    expect(ids(plan(['development'], { 'chat.channel': 'none' }))).not.toContain('modules');
  });

  test('someone who is not an admin is told who turns them on; nothing is called', () => {
    const steps = plan(['company'], {}, fresh({ isAdmin: false }));
    expect(step(steps, 'modules')).toMatchObject({ kind: 'done', title: expect.stringMatching(/Your admin turns on Cases, Mail/) });
  });

  test('the inbox watch waits for the inbox module, or says who turns it on', () => {
    const byUseCase = { company: [{ id: 'inbox', title: 'Email inbox' }] };
    const admin = plan(['company'], { 'company.mail': true }, fresh({ modules: { enabled: [], byUseCase } }));
    expect(step(admin, 'heartbeat:me')).toMatchObject({ kind: 'api', dependsOn: expect.arrayContaining(['modules']) });
    const member = plan(['company'], { 'company.mail': true }, fresh({ isAdmin: false, modules: { enabled: [], byUseCase } }));
    expect(step(member, 'heartbeat:me')).toMatchObject({ kind: 'done', title: expect.stringMatching(/admin turns on the email inbox/) });
  });

  test('without the chat channels, no messaging permission and no send_to_user', () => {
    const state = fresh({ modules: { enabled: ['inbox'], byUseCase: {} } });
    const steps = plan(['company'], { 'company.mail': true, 'company.urgent': 'invoices' }, state);
    expect(ids(steps)).not.toContain('perm:messaging/send');
    expect(ids(plan(['company'], { 'company.mail': true }))).toContain('perm:messaging/send');
    expect(standingInstructions({ 'company.urgent': 'invoices', _useCases: ['company'] }, false)).not.toContain('send_to_user');
  });

  test('the picker: a module added to a developer setup is turned on, one dropped is not', () => {
    const available = [{ id: 'business', title: 'Cases', description: '' }, { id: 'mail', title: 'Mail', description: '' }];
    const state = fresh({ modules: { enabled: [], byUseCase: fresh().modules.byUseCase, available } });
    expect(defaultModulesFor(['development'], {}, state)).toEqual([]);
    expect(defaultModulesFor(['company'], {}, state)).toEqual(['business', 'mail']);
    // A one-person business that builds software adds the cases and contacts.
    const added = plan(['development'], { [MODULES_PICKED]: ['business'] }, state);
    expect(step(added, 'modules')).toMatchObject({ kind: 'api', call: { body: { ids: ['business'] } } });
    // Unticking what the use case brought leaves it out.
    const dropped = plan(['company'], { 'company.mail': false, [MODULES_PICKED]: ['business'] }, state);
    expect(step(dropped, 'modules')).toMatchObject({ call: { body: { ids: ['business'] } } });
    expect(ids(plan(['company'], { 'company.mail': false, [MODULES_PICKED]: [] }, state))).not.toContain('modules');
    // An id the server does not offer is ignored.
    expect(step(plan(['development'], { [MODULES_PICKED]: ['nope', 'mail'] }, state), 'modules')).toMatchObject({ call: { body: { ids: ['mail'] } } });
  });

  test('the modules the answers need stay ticked: the chat channels for a chat, the inbox for the inbox watch', () => {
    const available = [{ id: 'channels', title: 'Chat channels', description: '' }, { id: 'inbox', title: 'Email inbox', description: '' }];
    const state = fresh({ modules: { enabled: [], byUseCase: {}, available } });
    expect(requiredModulesFor(['development'], { 'chat.channel': 'telegram' })).toEqual(['channels']);
    expect(requiredModulesFor(['company'], { 'company.mail': true })).toContain('inbox');
    // Unticked anyway: still turned on, so the chat and the inbox watch work.
    const steps = plan(['company'], { 'company.mail': true, [MODULES_PICKED]: [] }, state);
    expect(step(steps, 'modules')).toMatchObject({ call: { body: { ids: ['inbox'] } } });
    expect(step(steps, 'heartbeat:me')).toMatchObject({ kind: 'api' });
  });

  test('the picker never turns a module off: one already on stays, and is not asked for again', () => {
    const available = [{ id: 'business', title: 'Cases', description: '' }, { id: 'mail', title: 'Mail', description: '' }];
    const state = fresh({ modules: { enabled: ['mail'], byUseCase: fresh().modules.byUseCase, available } });
    const steps = plan(['company'], { 'company.mail': false, [MODULES_PICKED]: ['business'] }, state);
    expect(step(steps, 'modules')).toMatchObject({ call: { body: { ids: ['business'] } } });
  });

  test('a server that reports no modules: no step', () => {
    expect(ids(plan(['company'], {}, fresh({ modules: undefined as never })))).not.toContain('modules');
  });
});

describe('beginner readiness', () => {
  test('missing API keys cannot produce a ready chat; existing encrypted keys count', () => {
    const answers = initialAnswers([], fresh());
    expect(modelSetupProblem(answers, fresh())).toMatch(/API key/);
    expect(modelSetupProblem({ ...answers, 'models.key': 'test-key' }, fresh())).toBeNull();
    expect(modelSetupProblem(answers, fresh({ models: { ...fresh().models, providersWithKey: ['anthropic'] } }))).toBeNull();
    expect(initialAnswers(['research'], fresh())['models.embedding']).toBe('skip');
  });

  test('keeping a configured model still checks its connection without changing bindings', () => {
    const state = fresh({ models: { ...fresh().models, textReady: true, connection: { provider: 'openai', modelId: 'existing' } } });
    const steps = plan([], { 'models.source': 'keep' }, state);
    expect(step(steps, 'test:main')).toMatchObject({ call: { path: '/models/test', body: { provider: 'openai', modelId: 'existing' } } });
    expect(todo(steps)).not.toContain('assign-all');
  });

  test('keeping models still validates newly requested document search', () => {
    const state = fresh({ models: { ...fresh().models, textReady: true } });
    expect(modelSetupProblem({ 'models.source': 'keep', 'models.embedding': 'openai' }, state)).toMatch(/API key for document search/);
  });

  test('basic mode never acts on hidden saved answers', () => {
    const answers: Answers = { _basicsOnly: true, 'models.source': 'cli', 'models.cliTool': 'cli/claude-code', 'areas.separate': true, 'areas.names': ['Hidden project'], 'areas.team': true, 'areas.spaceName': 'Hidden team', 'areas.logins': true, 'areas.loginNames': ['hidden-login'], 'chat.channel': 'telegram', 'chat.telegramToken': 'secret', [MODULES_PICKED]: ['business'] };
    const steps = plan(['company'], answers);
    expect(ids(steps)).toEqual(['model:Claude Code CLI', 'test:main', 'assign-all', 'setup-complete']);
    expect(defaultModulesFor(['company'], answers, fresh())).toEqual([]);
    expect(requiredModulesFor(['company'], answers)).toEqual([]);
  });

  test('unavailable CLIs and invalid Ollama addresses need a useful correction', () => {
    expect(modelSetupProblem({ 'models.source': 'cli', 'models.cliTool': 'cli/codex' }, fresh())).toMatch(/Install and sign in/);
    expect(modelSetupProblem({ 'models.source': 'ollama', 'models.ollamaModel': 'local', 'models.ollamaUrl': 'file:///tmp' }, fresh())).toMatch(/http/);
  });

  test('Ollama is tested at the selected server before binding it', () => {
    const steps = plan([], { 'models.source': 'ollama', 'models.ollamaModel': 'local', 'models.ollamaUrl': 'http://server:11434' });
    expect(step(steps, 'test:main')).toMatchObject({ call: { body: { provider: 'ollama', modelId: 'local', endpoint: 'http://server:11434' } } });
    expect(step(steps, 'assign-all')?.dependsOn).toEqual(['test:main']);
  });
});
