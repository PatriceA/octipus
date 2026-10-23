/**
 * Answers → the steps that set Octipus up (docs/ONBOARDING.md). Pure: the web
 * guide shows the list before anything happens, then runs it step by step
 * through the existing API routes with the person's own session, so every
 * check those routes make (admin only, valid paths, known roles) still applies.
 *
 * A step whose result is already in place is not done again (a model that
 * exists is not added again, an enabled role agent is not re-enabled): it is
 * listed as `done`, so the person sees it was found, not forgotten. The same
 * step asked for by two use cases appears once.
 */
import { cliModelName, EMBEDDING_MODELS, KEY_PROVIDERS, picked, sectionsFor } from './use-cases';
import type { Answers, ApiCall, OnboardingState, PlanStep, UseCaseId } from './types';

/** The lanes `/topics/assign-all` binds (src/models/topics.ts TEXT_TOPIC_VALUES). */
const TEXT_LANES = ['build', 'everyday', 'verify', 'research', 'background'];

export interface PlanOptions {
  /** A password for each login the guide creates; the browser passes a random one. */
  newPassword: () => string;
}

/** The model config name the guide uses for a provider's model. */
export function modelName(provider: string, modelId: string): string {
  return `${provider} ${modelId}`;
}

/**
 * A workspace slug for an area name: lowercase letters, digits and dashes, at
 * most 32 characters, starting and ending with a letter or digit (the
 * server's rule). A name with no Latin letters or digits gets `area-<hash>`,
 * so two such names do not collide.
 */
export function slugify(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').slice(0, 32).replace(/^-+|-+$/g, '');
  if (base) return base;
  let h = 0;
  for (const ch of name) h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `area-${h.toString(36)}`;
}

const str = (a: Answers, id: string): string => (typeof a[id] === 'string' ? (a[id] as string).trim() : '');
const yes = (a: Answers, id: string): boolean => a[id] === true;
const list = (a: Answers, id: string): string[] => {
  const v = a[id];
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [];
  return [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
};

class Plan {
  private steps = new Map<string, PlanStep>();
  add(step: PlanStep): void {
    if (!this.steps.has(step.id)) this.steps.set(step.id, step);
  }
  has(id: string): boolean {
    return this.steps.has(id);
  }
  api(id: string, title: string, call: ApiCall, extra: { detail?: string; dependsOn?: string[]; optional?: boolean; secret?: boolean; reveal?: string } = {}): void {
    this.add({ id, title, kind: 'api', call, ...extra });
  }
  /** Already in place: listed, never called. */
  done(id: string, title: string, detail?: string): void {
    this.add({ id, title, kind: 'done', ...(detail ? { detail } : {}) });
  }
  list(): PlanStep[] {
    return [...this.steps.values()];
  }
}

/** Add a model unless it exists; returns the id of the step that makes it exist ('' when it already does). */
function ensureModel(plan: Plan, s: OnboardingState, name: string, body: Record<string, unknown>, title: string, dependsOn?: string[]): string {
  const id = `model:${name}`;
  if (s.models.names.includes(name)) {
    plan.done(id, `The model "${name}" is already added`);
    return '';
  }
  plan.api(id, title, { method: 'POST', path: '/models', body: { name, ...body } }, { dependsOn });
  return id;
}

/** Bind `name` to `topic` after the comma-separated step ids in `after`. */
function bind(plan: Plan, s: OnboardingState, topic: string, name: string, after: string, title: string): void {
  if (s.models.byTopic[topic] === name && !(TEXT_LANES.includes(topic) && plan.has('assign-all'))) {
    plan.done(`bind:${topic}`, `${title}: already set`);
    return;
  }
  const deps = after.split(',').filter(Boolean);
  plan.api(`bind:${topic}`, title, { method: 'PUT', path: `/topics/${topic}/binding`, body: { primaryModel: name } }, { dependsOn: deps.length ? deps : undefined });
}

function permission(plan: Plan, s: OnboardingState, toolId: 'tasks' | 'messaging', action: 'write' | 'send', why: string): void {
  const current = toolId === 'tasks' ? s.permissions.tasksWrite : s.permissions.messagingSend;
  if (current === 'ALLOW') {
    plan.done(`perm:${toolId}/${action}`, `Agents may already ${why}`, `${toolId} → ${action} is Allow.`);
    return;
  }
  plan.api(`perm:${toolId}/${action}`, `Allow agents to ${why}`, { method: 'PUT', path: '/tools/permissions', body: { toolId, action, level: 'ALLOW' } }, {
    detail: `${toolId} → ${action} set to Allow. Background runs cannot ask you, so anything left on Ask is refused.`,
  });
}

/** Background agents need the server's heartbeat. */
function serverHeartbeat(plan: Plan, s: OnboardingState): void {
  if (s.heartbeat.serverEnabled) {
    plan.done('setting:heartbeat.enabled', 'The heartbeat already runs on this server');
    return;
  }
  if (s.isAdmin) {
    plan.api('setting:heartbeat.enabled', 'Turn on the heartbeat for this server', { method: 'PUT', path: '/settings/heartbeat.enabled', body: { value: true } }, {
      detail: 'The regular check-in that background agents run on. A check that finds nothing costs nothing.',
    });
  } else {
    plan.add({ id: 'todo:heartbeat', kind: 'todo', title: 'Ask your admin to turn on the heartbeat', detail: 'Background agents only run when the server\'s heartbeat is on (heartbeat.enabled).', href: '/settings' });
  }
}

function roleAgent(plan: Plan, s: OnboardingState, role: string, pipelineTemplate: string, title: string): void {
  const existing = s.roleAgents.find((r) => r.role === role);
  const wanted = pipelineTemplate || null;
  if (existing?.enabled && existing.pipelineTemplate === wanted) {
    plan.done(`role:${role}`, `The ${role} agent is already on, working tasks the way you chose`);
    return;
  }
  serverHeartbeat(plan, s);
  permission(plan, s, 'tasks', 'write', 'work your to-do list');
  const template = s.pipelineTemplates.find((t) => t.id === pipelineTemplate);
  plan.api(`role:${role}`, title, { method: 'PUT', path: '/tasks/role-agents', body: { role, enabled: true, pipelineTemplate: wanted } }, {
    detail: template ? `Each task runs through the ${template.name} pipeline.` : 'It works each task itself.',
  });
}

function connectMailbox(plan: Plan, s: OnboardingState, provider: 'google' | 'microsoft', why: string): string {
  if (s.mailbox) {
    plan.done('connect:mailbox', `Your ${s.mailbox === 'google' ? 'Google' : 'Microsoft'} account is already connected`);
    return 'connect:mailbox';
  }
  if (!s.oauthClients[provider]) {
    const label = provider === 'google' ? 'Google' : 'Microsoft';
    plan.add({
      id: `todo:oauth-client:${provider}`,
      kind: 'todo',
      title: s.isAdmin ? `Add a ${label} sign-in client, then connect your mailbox` : `Ask your admin to add a ${label} sign-in client`,
      detail: `Connecting a mailbox needs an OAuth client for this server (Settings → Secrets → ${label}). Then come back here and press Set up again.`,
      href: '/secrets',
    });
    return `todo:oauth-client:${provider}`;
  }
  plan.add({
    id: 'connect:mailbox',
    kind: 'connect',
    title: `Connect your ${provider === 'google' ? 'Google' : 'Microsoft'} account`,
    detail: why,
    start: { method: 'GET', path: `/auth/oauth/${provider}/authorize` },
    doneWhen: { mailbox: true },
  });
  return 'connect:mailbox';
}

function modelSteps(plan: Plan, a: Answers, s: OnboardingState): void {
  if (!s.isAdmin) return;
  const source = str(a, 'models.source');
  let main = '';
  let mainStep = '';
  let tested: { provider: string; modelId: string } | null = null;
  let keyStep: string[] | undefined;
  if (source === 'key') {
    const provider = str(a, 'models.provider');
    const modelId = str(a, 'models.modelId') || KEY_PROVIDERS.find((p) => p.id === provider)?.model || '';
    const key = str(a, 'models.key');
    if (!provider || !modelId) return;
    if (key) {
      plan.api('key:main', `Store your ${KEY_PROVIDERS.find((p) => p.id === provider)?.label ?? provider} API key`, {
        method: 'PUT', path: '/settings/batch', body: { settings: { [`${provider}.apiKey`]: key } },
      }, { secret: true, detail: 'Encrypted in the vault.' });
      keyStep = ['key:main'];
    }
    main = modelName(provider, modelId);
    mainStep = ensureModel(plan, s, main, { provider, modelId }, `Add the model ${modelId}`, keyStep);
    tested = { provider, modelId };
  } else if (source === 'cli') {
    const tool = s.cliTools.find((t) => t.modelId === str(a, 'models.cliTool'));
    if (!tool) return;
    main = cliModelName(tool.name);
    mainStep = ensureModel(plan, s, main, { provider: 'cli', modelId: tool.modelId }, `Add ${tool.name} as a model`);
  } else if (source === 'ollama') {
    const url = str(a, 'models.ollamaUrl') || s.ollama.url;
    const modelId = str(a, 'models.ollamaModel');
    if (!modelId) return;
    ollamaUrl(plan, s, url);
    main = modelName('ollama', modelId);
    mainStep = ensureModel(plan, s, main, { provider: 'ollama', modelId, endpoint: url }, `Add the local model ${modelId}`);
  }

  if (source === 'keep' && s.models.textReady) plan.done('models:ready', 'Every kind of work already has a model');
  if (main && TEXT_LANES.every((t) => s.models.byTopic[t] === main)) plan.done('assign-all', `"${main}" is already used for all work`);
  else if (main) {
    plan.api('assign-all', 'Use it for all work', { method: 'POST', path: '/topics/assign-all', body: { model: main } }, {
      dependsOn: mainStep ? [mainStep] : undefined,
      detail: 'Chat, coding, research, checking and background jobs. Give single jobs their own model later on the Topics page.',
    });
  }
  if (tested) {
    plan.api('test:main', 'Check that the model answers', { method: 'POST', path: '/models/test', body: tested }, {
      dependsOn: mainStep ? [mainStep] : keyStep, optional: true,
    });
  }

  // A separate checker, bound after assign-all (which binds verify to the main model too).
  const verify = str(a, 'models.verifyModelId');
  if (source === 'key' && tested && yes(a, 'models.verify') && verify && verify !== tested.modelId) {
    const name = modelName(tested.provider, verify);
    const step = ensureModel(plan, s, name, { provider: tested.provider, modelId: verify }, `Add ${verify} for checking work`, keyStep);
    if (s.models.byTopic.verify !== name || plan.has('assign-all')) {
      plan.api('bind:verify', `Use ${verify} to check work`, { method: 'PUT', path: '/topics/verify/binding', body: { primaryModel: name } }, {
        dependsOn: [step, plan.has('assign-all') ? 'assign-all' : ''].filter(Boolean),
      });
    }
  }

  const embedding = str(a, 'models.embedding');
  if (embedding === 'keep' && s.models.embeddingReady) plan.done('models:embedding', 'Document search already has a model');
  if (embedding === 'ollama' || embedding === 'openai') {
    const m = EMBEDDING_MODELS[embedding];
    const url = str(a, 'models.ollamaUrl') || s.ollama.url;
    let deps: string[] | undefined;
    if (embedding === 'ollama') ollamaUrl(plan, s, url);
    const key = str(a, 'models.embeddingKey');
    if (embedding === 'openai' && key) {
      plan.api('key:openai', 'Store your OpenAI API key for search', { method: 'PUT', path: '/settings/batch', body: { settings: { 'openai.apiKey': key } } }, { secret: true });
      deps = ['key:openai'];
    }
    const name = modelName(m.provider, m.modelId);
    const step = ensureModel(plan, s, name, { provider: m.provider, modelId: m.modelId, ...(embedding === 'ollama' ? { endpoint: url } : {}) }, `Add ${m.modelId} for search`, deps);
    bind(plan, s, 'embedding', name, step, 'Use it to search documents, notes and memories');
  }
}

function ollamaUrl(plan: Plan, s: OnboardingState, url: string): void {
  if (!url || url === s.ollama.url) return;
  plan.api('setting:ollama.url', `Point Octipus at Ollama on ${url}`, { method: 'PUT', path: '/settings/ollama.url', body: { value: url } });
}

function areaSteps(plan: Plan, a: Answers, s: OnboardingState, opts: PlanOptions): void {
  if (yes(a, 'areas.separate')) {
    const known = new Set(s.workspaces.flatMap((w) => [w.name.toLowerCase(), w.slug]));
    for (const name of list(a, 'areas.names')) {
      const slug = slugify(name);
      if (known.has(name.toLowerCase()) || known.has(slug)) {
        plan.done(`area:${slug}`, `The area "${name}" already exists`);
        continue;
      }
      known.add(slug);
      plan.api(`area:${slug}`, `Create the area "${name}"`, { method: 'POST', path: '/me/workspaces', body: { slug, name: name.slice(0, 120) } }, {
        detail: 'Its own chats, tasks, notes and documents. Switch to it at the top of the page.',
      });
    }
  }
  const space = str(a, 'areas.spaceName');
  const hasSpace = s.workspaces.some((w) => w.kind === 'shared' && w.name.toLowerCase() === space.toLowerCase());
  if (yes(a, 'areas.team') && space && hasSpace) plan.done('space', `The shared space "${space}" already exists`);
  if (yes(a, 'areas.team') && space && !hasSpace) {
    plan.api('space', `Create the shared space "${space}"`, { method: 'POST', path: '/spaces', body: { name: space.slice(0, 120) } }, {
      detail: 'Invite people from the space\'s settings.',
    });
  }
  if (s.isAdmin && yes(a, 'areas.logins')) {
    for (const username of list(a, 'areas.loginNames')) {
      const clean = username.toLowerCase().replace(/[^a-z0-9._-]/g, '');
      if (!clean) continue;
      const password = opts.newPassword();
      plan.api(`login:${clean}`, `Create the login "${clean}"`, { method: 'POST', path: '/admin/users', body: { username: clean, password } }, {
        secret: true,
        reveal: `Login ${clean}, password ${password}. Copy it now: it is not shown again. Sign in as ${clean} to connect that company's mailbox and run this guide for it.`,
      });
    }
  }
}

function chatSteps(plan: Plan, a: Answers, s: OnboardingState): void {
  const channel = str(a, 'chat.channel');
  if (!channel || channel === 'none') return;
  if (s.channels.linked.includes(channel)) {
    plan.done(`link:${channel}`, `Your ${channel === 'teams' ? 'Teams' : channel[0].toUpperCase() + channel.slice(1)} chat is already linked`);
    return;
  }
  if (channel === 'telegram') {
    const token = str(a, 'chat.telegramToken');
    if (token) {
      plan.api('setting:telegram.botToken', 'Start your Telegram bot', { method: 'PUT', path: '/settings/telegram.botToken', body: { value: token } }, { secret: true });
    }
    if (s.channels.configured.includes('telegram') || token) {
      plan.add({
        id: 'link:telegram',
        kind: 'code',
        title: 'Link your Telegram account',
        prompt: 'In Telegram, open a private chat with your bot and send /link. It answers with a 6-character code: type it here.',
        call: { method: 'POST', path: '/auth/link', field: 'code' },
        dependsOn: token ? ['setting:telegram.botToken'] : undefined,
      });
      return;
    }
  }
  plan.add({
    id: `todo:channel:${channel}`,
    kind: 'todo',
    title: `Connect ${channel === 'teams' ? 'Microsoft Teams' : channel[0].toUpperCase() + channel.slice(1)}`,
    detail: s.channels.configured.includes(channel)
      ? 'Message the Octipus bot there and send /link; enter the code under Settings → Channels.'
      : s.isAdmin ? 'Its app credentials go under Settings → Channels.' : 'Ask your admin to connect it under Settings → Channels.',
    href: '/settings',
  });
}

function devSteps(plan: Plan, a: Answers, s: OnboardingState): void {
  if (s.isAdmin) {
    const chosen = list(a, 'dev.cli').map((id) => s.cliTools.find((t) => t.modelId === id)).filter((t) => t?.available);
    for (const tool of chosen) ensureModel(plan, s, cliModelName(tool!.name), { provider: 'cli', modelId: tool!.modelId }, `Add ${tool!.name} for coding agents`);
    if (yes(a, 'dev.cliForBuild') && chosen[0]) {
      const name = cliModelName(chosen[0].name);
      const after = plan.has(`model:${name}`) ? `model:${name}` : '';
      // After assign-all (models section), which binds build to the main model.
      bind(plan, s, 'build', name, [after, plan.has('assign-all') ? 'assign-all' : ''].filter(Boolean).join(','), `Use ${chosen[0].name} for coding work`);
    }
    const root = str(a, 'dev.root');
    if (root && root === s.workspaceRoot) plan.done('workspace-root', `Agents already work in ${root}`);
    if (root && root !== s.workspaceRoot) {
      plan.api('workspace-root', `Work in ${root}`, { method: 'PUT', path: '/workspace', body: { rootPath: root } }, { detail: 'Agents read and write code inside this folder.' });
    }
  }
  const token = str(a, 'dev.githubToken');
  if (token) {
    plan.api('vault:github_token', 'Store your GitHub token', { method: 'POST', path: '/vault', body: { name: 'github_token', value: token, credentialType: 'api_key' } }, { secret: true, optional: true });
  }
  if (yes(a, 'dev.roleAgent')) roleAgent(plan, s, 'coding', str(a, 'dev.pipeline'), 'Turn on the coding agent');
}

function trackerSteps(plan: Plan, a: Answers, s: OnboardingState): void {
  const tracker = str(a, 'tools.tracker');
  const connector = tracker === 'jira' ? 'atlassian' : tracker === 'linear' ? 'linear' : '';
  if (connector && s.connectors.find((c) => c.id === connector)?.connected) {
    plan.done(`connect:${connector}`, `${tracker === 'jira' ? 'Jira' : 'Linear'} is already connected`);
  } else if (connector) {
    plan.add({
      id: `connect:${connector}`,
      kind: 'connect',
      title: tracker === 'jira' ? 'Connect Jira and Confluence' : 'Connect Linear',
      detail: 'Sign in in the window that opens; agents then read and update your tickets as you.',
      start: { method: 'POST', path: `/connectors/${connector}/authorize` },
      doneWhen: { connector },
    });
  }
  const url = str(a, 'tools.mcpUrl');
  const name = str(a, 'tools.mcpName') || 'tracker';
  if (tracker === 'mcp' && s.isAdmin && s.mcpServers.includes(name)) plan.done(`mcp:${name}`, `The MCP server "${name}" already exists`);
  else if (tracker === 'mcp' && s.isAdmin && url) {
    plan.api(`mcp:${name}`, `Add the MCP server "${name}"`, {
      method: 'POST', path: '/mcp/servers', body: { name, transport: 'streamable-http', sseUrl: url, isEnabled: true },
    }, { detail: url });
  }
}

/** The standing instructions the heartbeat reads, from the company answers. Pure. */
export function standingInstructions(a: Answers): string {
  const lines = ['# HEARTBEAT', ''];
  const name = str(a, 'company.name');
  const about = str(a, 'company.about');
  if (name || about) lines.push(`About ${name || 'the company'}: ${about || '(not described yet)'}`, '');
  if (yes(a, 'company.mail')) {
    lines.push('## Email');
    const urgent = str(a, 'company.urgent');
    if (urgent) lines.push(`- Tell me right away (send_to_user) about: ${urgent.replace(/\s*\n\s*/g, '; ')}`);
    lines.push('- Work that needs doing: add a task with the email as source.');
    lines.push('- Newsletters, notifications and receipts: no action.');
    lines.push(str(a, 'company.send') === 'send'
      ? '- Routine replies may be sent; anything about money, contracts or complaints is drafted for me instead.'
      : '- Never send email: save a reply draft and tell me it is there.');
    lines.push('');
  }
  if (yes(a, 'company.ideas')) {
    lines.push('## Ideas', '- Ideas on my list assigned to "general" are yours to work on: research first, then a short plan, then ask me before anything costs money.', '');
  }
  return lines.join('\n').trim();
}

function companySteps(plan: Plan, a: Answers, s: OnboardingState): void {
  const body = standingInstructions(a);
  if (body.split('\n').length > 1) {
    plan.api('standing-instructions', s.standingInstructions ? 'Add to your standing instructions' : 'Write your standing instructions', {
      method: 'PUT', path: '/onboarding/standing-instructions', body: { body },
    }, { detail: 'The pinned "heartbeat" note every check-in reads. Edit it any time under Notes.' });
  }
  if (yes(a, 'company.mail')) {
    const provider = str(a, 'mailbox.provider') === 'microsoft' ? 'microsoft' : 'google';
    const connect = connectMailbox(plan, s, provider, 'Octipus reads new mail and saves drafts; it does not send unless you allow it.');
    serverHeartbeat(plan, s);
    permission(plan, s, 'tasks', 'write', 'add tasks to your list');
    permission(plan, s, 'messaging', 'send', 'message you in your chat');
    const interval = Number(str(a, 'company.interval')) || 15;
    if (s.heartbeat.enabled && s.heartbeat.watchEmail && s.heartbeat.intervalMinutes === interval) {
      plan.done('heartbeat:me', `Your inbox is already checked every ${interval} minutes`);
    } else {
      plan.api('heartbeat:me', `Check your inbox every ${interval} minutes`, {
        method: 'PUT', path: '/heartbeat/me', body: { enabled: true, watchEmail: true, intervalMinutes: interval },
      }, { dependsOn: connect && connect.startsWith('connect:') ? [connect] : undefined, detail: 'Only mail that arrives from now on.' });
    }
  }
  if (yes(a, 'company.ideas')) roleAgent(plan, s, 'general', str(a, 'company.ideasPipeline'), 'Turn on an agent for your ideas (role "general")');
}

function productSteps(plan: Plan, a: Answers, s: OnboardingState): void {
  if (yes(a, 'product.roleAgent')) roleAgent(plan, s, 'pm', str(a, 'product.pipeline'), 'Turn on the product agent (role "pm")');
  if (yes(a, 'product.calendar')) {
    const provider = str(a, 'mailbox.provider') === 'microsoft' ? 'microsoft' : 'google';
    const connect = connectMailbox(plan, s, provider, 'Octipus reads your calendar to prepare you for meetings.');
    serverHeartbeat(plan, s);
    if (s.heartbeat.enabled) plan.done('heartbeat:me', 'Your heartbeat is already on');
    else if (!plan.has('heartbeat:me')) {
      plan.api('heartbeat:me', 'Turn on your heartbeat', { method: 'PUT', path: '/heartbeat/me', body: { enabled: true } }, {
        dependsOn: connect && connect.startsWith('connect:') ? [connect] : undefined,
      });
    }
  }
}

function researchSteps(plan: Plan, a: Answers, s: OnboardingState): void {
  if (yes(a, 'research.roleAgent')) roleAgent(plan, s, 'research', str(a, 'research.pipeline'), 'Turn on the research agent');
}

/**
 * The modules the picked use cases bring (docs/MODULES.md), switched on
 * install-wide by an admin. Only turned on, never off: a second run of the
 * guide with fewer use cases leaves alone what is already on.
 */
function moduleSteps(plan: Plan, useCases: readonly UseCaseId[], s: OnboardingState): void {
  // A server from before modules reports none: nothing to switch.
  const modules = s.modules ?? { enabled: [], byUseCase: {} };
  const wanted = new Map<string, string>();
  for (const useCase of useCases) for (const m of modules.byUseCase[useCase] ?? []) wanted.set(m.id, m.title);
  if (wanted.size === 0) return;
  const missing = [...wanted].filter(([id]) => !modules.enabled.includes(id));
  if (missing.length === 0) {
    plan.done('modules', `Already on: ${[...wanted.values()].join(', ')}`);
    return;
  }
  // Switching is install-wide: someone else is told who does it.
  if (!s.isAdmin) {
    plan.done('modules', `Your admin turns on ${missing.map(([, title]) => title).join(', ')} in Settings → Modules`);
    return;
  }
  plan.api('modules', `Turn on ${missing.map(([, title]) => title).join(', ')}`, {
    method: 'POST', path: '/modules/enable', body: { ids: missing.map(([id]) => id) },
  }, { detail: 'For everyone on this install. Settings → Modules switches them off again; their data stays.' });
}

/**
 * The plan for these use cases and answers, in the order it runs. Questions
 * of sections the use cases do not bring in are ignored, whatever their
 * saved answer.
 */
export function buildPlan(useCases: readonly UseCaseId[], answers: Answers, state: OnboardingState, opts: PlanOptions): PlanStep[] {
  const a: Answers = { ...answers, _useCases: [...useCases] };
  const asked = new Set(sectionsFor(useCases).map((s) => s.id));
  const plan = new Plan();
  // First: the later steps may use what a module brings.
  moduleSteps(plan, useCases, state);
  if (asked.has('models')) modelSteps(plan, a, state);
  if (asked.has('areas')) areaSteps(plan, a, state, opts);
  if (asked.has('chat')) chatSteps(plan, a, state);
  if (asked.has('dev')) devSteps(plan, a, state);
  if (asked.has('tools')) trackerSteps(plan, a, state);
  if (asked.has('company')) companySteps(plan, a, state);
  if (asked.has('product')) productSteps(plan, a, state);
  if (picked(a, 'research') && asked.has('research')) researchSteps(plan, a, state);
  if (state.isAdmin && !state.setupComplete) {
    plan.api('setup-complete', 'Mark the setup as done', { method: 'POST', path: '/settings/setup-complete' }, { optional: true });
  }
  return plan.list();
}
