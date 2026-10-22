/**
 * What the onboarding guide asks (docs/ONBOARDING.md): the use cases a person
 * picks from, and the sections of questions each brings in. Three sections
 * are asked of everyone (models, areas of work, a chat); the rest come with a
 * use case. A question that is already answered by the install says so
 * (`alreadyDone`) and starts from what is there.
 *
 * Questions only collect answers; `plan.ts` turns them into the calls that
 * set things up, so the two can be read (and tested) apart.
 */
import type { Answers, OnboardingState, Question, QuestionOption, Section, UseCase, UseCaseId } from './types';

export const USE_CASES: UseCase[] = [
  {
    id: 'development',
    title: 'Build software',
    summary: 'Coding agents (Claude Code, Codex, Gemini), your repositories, GitHub and your issue tracker, and pipelines that plan, build and check work.',
    sets: ['coding agents', 'repositories folder', 'GitHub', 'Jira or Linear', 'a coding agent for your tasks'],
  },
  {
    id: 'company',
    title: 'Run my company',
    summary: 'Octipus watches your inbox, puts what needs doing on your to-do list, tells you what is urgent, drafts replies and works on your ideas.',
    sets: ['your mailbox', 'inbox watch', 'standing instructions', 'an agent for your ideas'],
  },
  {
    id: 'product',
    title: 'Product management',
    summary: 'Your tracker (Jira or Linear), a product agent for specs, stories and release notes, research on markets and competitors, and your calendar.',
    sets: ['Jira or Linear', 'a product agent', 'research', 'calendar check-ins'],
  },
  {
    id: 'research',
    title: 'Research and knowledge',
    summary: 'Search across your documents, notes and memories, and a research agent that digs into questions you put on your list.',
    sets: ['document search', 'a research agent'],
  },
];

/** API-key providers the guide offers, with a model to start from (editable, and checked after). */
export const KEY_PROVIDERS: Array<{ id: string; label: string; model: string; hint?: string }> = [
  { id: 'anthropic', label: 'Anthropic (Claude)', model: 'claude-sonnet-5-5' },
  { id: 'openai', label: 'OpenAI', model: 'gpt-4o-mini' },
  { id: 'gemini', label: 'Google Gemini', model: 'gemini-2.0-flash' },
  { id: 'openrouter', label: 'OpenRouter (many models, one key)', model: 'openai/gpt-4o-mini' },
  { id: 'mistral', label: 'Mistral', model: 'mistral-large-latest' },
  { id: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat' },
  { id: 'grok', label: 'xAI Grok', model: 'grok-4' },
  { id: 'zai', label: 'Z.AI (GLM)', model: 'glm-4.6' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', model: 'kimi-k2-0711-preview' },
];

export const EMBEDDING_MODELS = {
  ollama: { provider: 'ollama', modelId: 'nomic-embed-text' },
  openai: { provider: 'openai', modelId: 'text-embedding-3-small' },
} as const;

const has = (a: Answers, id: string): boolean => a[id] === true;
const is = (a: Answers, id: string, value: string): boolean => a[id] === value;
export const picked = (a: Answers, useCase: UseCaseId): boolean => Array.isArray(a._useCases) && a._useCases.includes(useCase);

/** Run each task "itself" or through one of the user's pipeline templates. */
function pipelineOptions(s: OnboardingState): QuestionOption[] {
  return [
    { value: '', label: 'Itself, in one agent turn', hint: 'Quick and cheap; good for small tasks' },
    ...s.pipelineTemplates.map((t) => ({ value: t.id, label: `Through the ${t.name} pipeline`, hint: 'Plans, works each step, checks the result' })),
  ];
}

function templateId(s: OnboardingState, name: string): string {
  return s.pipelineTemplates.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id ?? '';
}

const roleAgentDone = (role: string) => (s: OnboardingState): string | null =>
  s.roleAgents.find((r) => r.role === role && r.enabled) ? `The ${role} agent is already on.` : null;

const modelQuestions: Question[] = [
  {
    id: 'models.source',
    kind: 'choice',
    prompt: 'How should Octipus reach an AI model?',
    help: 'One model for everything is fine to start; you can give single jobs their own model later on the Topics page.',
    options: (s) => [
      ...(s.models.textReady ? [{ value: 'keep', label: 'Keep the models already set up' }] : []),
      { value: 'key', label: 'With an API key', hint: 'Anthropic, OpenAI, Gemini, OpenRouter, …' },
      { value: 'cli', label: 'Through a coding CLI I am signed in to', hint: 'Claude Code, Codex or Gemini CLI on this computer; uses your subscription' },
      { value: 'ollama', label: 'Local models with Ollama', hint: 'Free and private; needs a capable computer' },
    ],
    initial: (s) => (s.models.textReady ? 'keep' : 'key'),
    alreadyDone: (s) => (s.models.textReady ? 'Every kind of work already has a model.' : null),
  },
  {
    id: 'models.provider',
    kind: 'choice',
    prompt: 'Which provider is the key for?',
    options: (s) => KEY_PROVIDERS.map((p) => ({ value: p.id, label: p.label, hint: s.models.providersWithKey.includes(p.id) ? 'key already stored' : undefined })),
    initial: () => 'anthropic',
    when: (a) => is(a, 'models.source', 'key'),
  },
  {
    id: 'models.key',
    kind: 'secret',
    prompt: 'Paste the API key',
    help: 'Stored encrypted in the vault, never in the guide\'s saved answers. Leave empty to keep a key already stored.',
    when: (a) => is(a, 'models.source', 'key'),
    alreadyDone: (s, a) => (s.models.providersWithKey.includes(String(a['models.provider'])) ? 'A key for this provider is already stored.' : null),
  },
  {
    id: 'models.modelId',
    kind: 'text',
    prompt: 'Model to use',
    help: 'After setup the guide sends it a short test message, so a wrong name shows up right away.',
    when: (a) => is(a, 'models.source', 'key'),
    initial: (_s, a) => KEY_PROVIDERS.find((p) => p.id === a['models.provider'])?.model,
  },
  {
    id: 'models.cliTool',
    kind: 'choice',
    prompt: 'Which CLI?',
    options: (s) => s.cliTools.map((t) => ({ value: t.modelId, label: t.name, hint: t.available ? 'found on this computer' : 'not installed', disabled: !t.available })),
    initial: (s) => s.cliTools.find((t) => t.available)?.modelId,
    when: (a) => is(a, 'models.source', 'cli'),
  },
  {
    id: 'models.ollamaUrl',
    kind: 'text',
    prompt: 'Where Ollama runs',
    initial: (s) => s.ollama.url,
    alreadyDone: (s) => (s.ollama.reachable ? 'Ollama answers at this address.' : null),
    when: (a) => is(a, 'models.source', 'ollama') || is(a, 'models.embedding', 'ollama'),
  },
  {
    id: 'models.ollamaModel',
    kind: 'text',
    prompt: 'Ollama model',
    help: 'It must already be pulled (`ollama pull <name>`).',
    initial: () => 'qwen3:8b',
    when: (a) => is(a, 'models.source', 'ollama'),
  },
  {
    id: 'models.verify',
    kind: 'yesno',
    prompt: 'Should a second model double-check work (reviews and QA)?',
    help: 'A model checking its own work tends to agree with itself. Recommended for building software.',
    initial: (_s, a) => picked(a, 'development'),
    alreadyDone: (s) => (s.models.verifySeparate ? 'Checking already uses its own model.' : null),
    when: (a) => is(a, 'models.source', 'key'),
  },
  {
    id: 'models.verifyModelId',
    kind: 'text',
    prompt: 'Second model (same provider)',
    when: (a) => is(a, 'models.source', 'key') && has(a, 'models.verify'),
  },
  {
    id: 'models.embedding',
    kind: 'choice',
    prompt: 'Search across your documents, notes and memories?',
    help: 'Needs an embedding model, a small model that indexes text.',
    options: (s) => [
      ...(s.models.embeddingReady ? [{ value: 'keep', label: 'Keep the one already set up' }] : []),
      { value: 'ollama', label: 'Yes, locally with Ollama (nomic-embed-text)' },
      { value: 'openai', label: 'Yes, with OpenAI (text-embedding-3-small)' },
      { value: 'skip', label: 'Not now' },
    ],
    initial: (s, a) => (s.models.embeddingReady ? 'keep' : picked(a, 'research') ? 'ollama' : 'skip'),
    alreadyDone: (s) => (s.models.embeddingReady ? 'Document search already has a model.' : null),
  },
  {
    id: 'models.embeddingKey',
    kind: 'secret',
    prompt: 'OpenAI API key for search',
    when: (a, s) => is(a, 'models.embedding', 'openai') && !s.models.providersWithKey.includes('openai')
      && !(is(a, 'models.source', 'key') && is(a, 'models.provider', 'openai')),
  },
];

const areaQuestions: Question[] = [
  {
    id: 'areas.separate',
    kind: 'yesno',
    prompt: 'Keep some work apart from the rest?',
    help: 'For example your company and your private projects. Each area has its own chats, tasks, notes and documents; you switch between them at the top of the page.',
    initial: () => false,
  },
  {
    id: 'areas.names',
    kind: 'list',
    prompt: 'Name the areas',
    placeholder: 'Acme Ltd',
    help: 'One per line. Areas you already have are left as they are.',
    when: (a) => has(a, 'areas.separate'),
    alreadyDone: (s) => (s.workspaces.length > 1 ? `You already have: ${s.workspaces.filter((w) => w.kind === 'personal').map((w) => w.name).join(', ')}.` : null),
  },
  {
    id: 'areas.team',
    kind: 'yesno',
    prompt: 'Will other people work with you in Octipus?',
    help: 'A shared space holds the team\'s notes, tasks and documents; you invite people to it.',
    initial: () => false,
  },
  {
    id: 'areas.spaceName',
    kind: 'text',
    prompt: 'Name of the shared space',
    placeholder: 'Acme team',
    when: (a) => has(a, 'areas.team'),
  },
  {
    id: 'areas.logins',
    kind: 'yesno',
    prompt: 'Does each company have its own mailbox?',
    help: 'Octipus connects one Google and one Microsoft mailbox per login. Companies with separate mailboxes each get their own login; the guide creates them and shows their passwords once.',
    initial: () => false,
    when: (a, s) => s.isAdmin && picked(a, 'company') && has(a, 'areas.separate'),
  },
  {
    id: 'areas.loginNames',
    kind: 'list',
    prompt: 'A login name per company (lowercase)',
    placeholder: 'acme',
    when: (a, s) => s.isAdmin && has(a, 'areas.logins'),
  },
];

const chatQuestions: Question[] = [
  {
    id: 'chat.channel',
    kind: 'choice',
    prompt: 'Where should Octipus reach you when you are not at the computer?',
    help: 'Urgent mail, approvals and finished work go there, and you can answer from your phone.',
    options: (s) => [
      { value: 'telegram', label: 'Telegram', hint: s.channels.linked.includes('telegram') ? 'already linked' : 'quickest to set up' },
      { value: 'slack', label: 'Slack', hint: s.channels.linked.includes('slack') ? 'already linked' : undefined },
      { value: 'teams', label: 'Microsoft Teams', hint: s.channels.linked.includes('teams') ? 'already linked' : undefined },
      { value: 'whatsapp', label: 'WhatsApp', hint: s.channels.linked.includes('whatsapp') ? 'already linked' : undefined },
      { value: 'none', label: 'Only in the web app' },
    ],
    initial: (s) => s.channels.linked[0] ?? 'none',
    alreadyDone: (s) => (s.channels.linked.length ? `Linked: ${s.channels.linked.join(', ')}.` : null),
  },
  {
    id: 'chat.telegramToken',
    kind: 'secret',
    prompt: 'Telegram bot token',
    help: 'In Telegram, message @BotFather, send /newbot and paste the token it gives you.',
    when: (a, s) => is(a, 'chat.channel', 'telegram') && s.isAdmin && !s.channels.configured.includes('telegram') && !s.channels.linked.includes('telegram'),
  },
];

const toolQuestions: Question[] = [
  {
    id: 'tools.tracker',
    kind: 'choice',
    prompt: 'Which issue tracker do you use?',
    options: (s) => {
      const on = (id: string) => s.connectors.find((c) => c.id === id)?.connected;
      return [
        { value: 'jira', label: 'Jira (Atlassian Cloud)', hint: on('atlassian') ? 'already connected' : 'signs in with your Atlassian account; Confluence too' },
        { value: 'linear', label: 'Linear', hint: on('linear') ? 'already connected' : undefined },
        ...(s.isAdmin ? [{ value: 'mcp', label: 'Another tool with an MCP server', hint: 'Jira Data Center, YouTrack, … by its MCP address' }] : []),
        { value: 'none', label: 'None' },
      ];
    },
    initial: () => 'none',
  },
  {
    id: 'tools.mcpName',
    kind: 'text',
    prompt: 'Name for the server',
    placeholder: 'jira',
    when: (a) => is(a, 'tools.tracker', 'mcp'),
  },
  {
    id: 'tools.mcpUrl',
    kind: 'text',
    prompt: 'MCP server address (https://…)',
    placeholder: 'https://jira.example.com/mcp',
    when: (a) => is(a, 'tools.tracker', 'mcp'),
  },
];

const devQuestions: Question[] = [
  {
    id: 'dev.cli',
    kind: 'multi',
    prompt: 'Which coding CLIs should agents be able to use?',
    help: 'Each runs with your own sign-in on this computer.',
    options: (s) => s.cliTools.map((t) => ({ value: t.modelId, label: t.name, hint: t.available ? 'found' : 'not installed', disabled: !t.available })),
    initial: (s) => s.cliTools.filter((t) => t.available).map((t) => t.modelId),
    alreadyDone: (s) => {
      const registered = s.cliTools.filter((t) => s.models.names.includes(cliModelName(t.name)));
      return registered.length ? `Already added: ${registered.map((t) => t.name).join(', ')}.` : null;
    },
  },
  {
    id: 'dev.cliForBuild',
    kind: 'yesno',
    prompt: 'Use the first of them for coding work?',
    help: 'Coding, architecture and reviews then run in that CLI; chat and the rest keep the main model.',
    initial: () => true,
    when: (a) => Array.isArray(a['dev.cli']) && a['dev.cli'].length > 0,
  },
  {
    id: 'dev.root',
    kind: 'text',
    prompt: 'Folder with your repositories',
    help: 'Agents work inside this folder. It must be in your home folder.',
    placeholder: '/home/me/code',
    initial: (s) => s.workspaceRoot ?? undefined,
  },
  {
    id: 'dev.githubToken',
    kind: 'secret',
    prompt: 'GitHub token (optional)',
    help: 'Without one, agents use the GitHub CLI login of this computer (`gh auth login`). A token is stored in your vault as github_token.',
  },
  {
    id: 'dev.roleAgent',
    kind: 'yesno',
    prompt: 'Let a coding agent pick up tasks you assign to "coding"?',
    help: 'It wakes on the heartbeat, takes one ready task, works it and comments on it.',
    initial: () => true,
    alreadyDone: roleAgentDone('coding'),
  },
  {
    id: 'dev.pipeline',
    kind: 'choice',
    prompt: 'How should it work each task?',
    options: pipelineOptions,
    initial: (s) => templateId(s, 'Full Development Cycle'),
    when: (a) => has(a, 'dev.roleAgent'),
  },
];

const companyQuestions: Question[] = [
  {
    id: 'company.name',
    kind: 'text',
    prompt: 'Company name',
    placeholder: 'Acme Design',
  },
  {
    id: 'company.about',
    kind: 'longtext',
    prompt: 'In two or three sentences: what does it do, and who are your customers?',
    help: 'Agents read this before every check-in, so they can tell a client from a newsletter.',
  },
  {
    id: 'company.mail',
    kind: 'yesno',
    prompt: 'Should Octipus watch your inbox?',
    help: 'Each new email is either left alone, put on your to-do list, flagged to you, or answered with a draft for you to send.',
    initial: () => true,
    alreadyDone: (s) => (s.heartbeat.watchEmail ? 'Your inbox is already watched.' : null),
  },
  {
    id: 'company.urgent',
    kind: 'longtext',
    prompt: 'What should you hear about right away?',
    placeholder: 'Anything from the bank or the tax office; client complaints; payments over 1000',
    when: (a) => has(a, 'company.mail'),
  },
  {
    id: 'company.send',
    kind: 'choice',
    prompt: 'Replies to email',
    options: [
      { value: 'draft', label: 'Draft them; I send them myself', hint: 'recommended' },
      { value: 'send', label: 'Agents may send routine replies', hint: 'you also have to allow sending on the Permissions page' },
    ],
    initial: () => 'draft',
    when: (a) => has(a, 'company.mail'),
  },
  {
    id: 'company.interval',
    kind: 'choice',
    prompt: 'How often should it check?',
    options: [
      { value: '15', label: 'Every 15 minutes' },
      { value: '30', label: 'Every 30 minutes' },
      { value: '60', label: 'Every hour' },
    ],
    initial: () => '15',
    when: (a) => has(a, 'company.mail'),
  },
  {
    id: 'company.ideas',
    kind: 'yesno',
    prompt: 'Should an agent work on ideas you put on your to-do list?',
    help: 'Assign an idea to the agent\'s role and it picks it up on its own: research, a plan, a draft.',
    initial: () => true,
    alreadyDone: roleAgentDone('general'),
  },
  {
    id: 'company.ideasPipeline',
    kind: 'choice',
    prompt: 'How should it work each idea?',
    options: pipelineOptions,
    initial: (s) => templateId(s, 'Research & Analysis'),
    when: (a) => has(a, 'company.ideas'),
  },
];

const productQuestions: Question[] = [
  {
    id: 'product.roleAgent',
    kind: 'yesno',
    prompt: 'Let a product agent work tasks you assign to "pm"?',
    help: 'Specs, user stories, release notes, sizing.',
    initial: () => true,
    alreadyDone: roleAgentDone('pm'),
  },
  {
    id: 'product.pipeline',
    kind: 'choice',
    prompt: 'How should it work each task?',
    options: pipelineOptions,
    initial: () => '',
    when: (a) => has(a, 'product.roleAgent'),
  },
  {
    id: 'product.calendar',
    kind: 'yesno',
    prompt: 'Prepare you for meetings from your calendar?',
    help: 'Connects your Google or Microsoft calendar; shortly before a meeting the heartbeat gathers what you need.',
    initial: () => false,
  },
];

/** Asked when the inbox watch or the calendar needs a mailbox. */
const mailboxQuestions: Question[] = [
  {
    id: 'mailbox.provider',
    kind: 'choice',
    prompt: 'Which mailbox?',
    options: (s) => [
      { value: 'google', label: 'Gmail / Google Workspace', hint: s.mailbox === 'google' ? 'connected' : !s.oauthClients.google ? 'needs a Google sign-in client first' : undefined },
      { value: 'microsoft', label: 'Outlook / Microsoft 365', hint: s.mailbox === 'microsoft' ? 'connected' : !s.oauthClients.microsoft ? 'needs a Microsoft sign-in client first' : undefined },
    ],
    initial: (s) => s.mailbox ?? 'google',
    when: (a) => has(a, 'company.mail') || has(a, 'product.calendar'),
  },
];

const researchQuestions: Question[] = [
  {
    id: 'research.roleAgent',
    kind: 'yesno',
    prompt: 'Let a research agent dig into questions you assign to "research"?',
    initial: () => true,
    alreadyDone: roleAgentDone('research'),
  },
  {
    id: 'research.pipeline',
    kind: 'choice',
    prompt: 'How should it work each question?',
    options: pipelineOptions,
    initial: (s) => templateId(s, 'Research & Analysis'),
    when: (a) => has(a, 'research.roleAgent'),
  },
];

export const SECTIONS: Section[] = [
  {
    id: 'models',
    title: 'AI models',
    intro: 'Everything Octipus does goes through a model. Pick how to reach one.',
    useCases: 'all',
    adminOnly: true,
    nonAdminNote: 'Models are set up by your admin. You can add your own under Settings → My models.',
    questions: modelQuestions,
  },
  { id: 'areas', title: 'Areas of work', intro: 'Keep separate things separate.', useCases: 'all', questions: areaQuestions },
  { id: 'chat', title: 'Your chat', intro: 'Octipus can message you, and you can answer it.', useCases: 'all', questions: chatQuestions },
  { id: 'dev', title: 'Building software', intro: 'Coding agents and where your code lives.', useCases: ['development'], questions: devQuestions },
  { id: 'tools', title: 'Issue tracker', intro: 'Let agents read and update your tickets.', useCases: ['development', 'product'], questions: toolQuestions },
  { id: 'company', title: 'Your company', intro: 'Your inbox, your to-do list and what matters to you.', useCases: ['company'], questions: companyQuestions },
  { id: 'product', title: 'Product work', intro: 'Specs, stories and meetings.', useCases: ['product'], questions: productQuestions },
  { id: 'mailbox', title: 'Mailbox and calendar', intro: 'Connect the account your mail and meetings are in.', useCases: ['company', 'product'], questions: mailboxQuestions },
  { id: 'research', title: 'Research', intro: 'Questions answered from the web and your own documents.', useCases: ['research'], questions: researchQuestions },
];

/** The model config name the guide gives a CLI agent. */
export function cliModelName(toolName: string): string {
  return `${toolName} CLI`;
}

/** The sections for the chosen use cases, in order. */
export function sectionsFor(useCases: readonly UseCaseId[]): Section[] {
  return SECTIONS.filter((s) => s.useCases === 'all' || s.useCases.some((u) => useCases.includes(u)));
}

/** A question's options for this state and these answers. */
export function optionsOf(q: Question, s: OnboardingState, a: Answers): QuestionOption[] {
  return typeof q.options === 'function' ? q.options(s, a) : (q.options ?? []);
}

/** The questions of `section` asked with these answers. */
export function visibleQuestions(section: Section, a: Answers, s: OnboardingState): Question[] {
  if (section.adminOnly && !s.isAdmin) return [];
  return section.questions.filter((q) => !q.when || q.when(a, s));
}

/**
 * Starting answers for the chosen use cases: each question's `initial`,
 * then whatever was saved last time on top. Questions are filled in order,
 * so a later question's `initial` sees the earlier ones.
 */
export function initialAnswers(useCases: readonly UseCaseId[], s: OnboardingState, saved: Answers = {}): Answers {
  const a: Answers = { ...saved, _useCases: [...useCases] };
  for (const section of sectionsFor(useCases)) {
    for (const q of section.questions) {
      if (a[q.id] !== undefined || !q.initial) continue;
      const v = q.initial(s, a);
      if (v !== undefined) a[q.id] = v;
    }
  }
  return a;
}

/** Answers safe to save: no secret ever leaves the browser except to the call that stores it. */
export function storableAnswers(a: Answers): Answers {
  const secret = new Set(SECTIONS.flatMap((s) => s.questions).filter((q) => q.kind === 'secret').map((q) => q.id));
  return Object.fromEntries(Object.entries(a).filter(([k]) => !secret.has(k)));
}
