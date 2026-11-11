/**
 * The plugin package contract as an author needs it (creator mode,
 * docs/PLUGIN-PACKAGES.md#writing-a-plugin-with-an-agent), what
 * `plugin_dev__plugin_api` returns.
 *
 * Derived from the code wherever the code holds it, so it cannot drift: the
 * manifest's JSON schema from the zod schema the install parses with (a new
 * manifest field shows up here as soon as it is in the schema), the event
 * names, effects, runtimes and limits from their constants, the environment
 * from the names the server is started with, and the sandbox state from what
 * this host would do now. Prose is kept to what a constant cannot say, and
 * keyed by those constants (a new effect or event fails to compile until it
 * is described).
 */
import { z } from 'zod';
import { DEFAULT_REQUEST_TIMEOUT_MS, MCP_PROTOCOL_VERSION } from '@/mcp/protocol';
import { MINIMAL_ENV_NAMES } from '@/security/child-env';
import { proxyEnv } from '@/security/egress-proxy';
import { activeSandboxRunner, getSandboxMode } from '@/security/shell-sandbox';
import { pluginSandboxView } from '../sandbox-policy';
import { MAX_MODEL_TRUST_REASON_CHARS, MAX_PLUGIN_SECRET_LENGTH, PLUGIN_HOST_ALIAS, PLUGIN_HOST_META_KEY, PLUGIN_HOST_START_SCOPES, PLUGIN_HOST_WRITE_SCOPES, PLUGIN_MANIFEST_FILE, PLUGIN_MODEL_CLI_TOOLS_APPROVAL, PLUGIN_PACKAGE_API_VERSION, PLUGIN_STORE_DEFAULT_QUOTA_BYTES, PLUGIN_STORE_MAX_ENTRIES, PLUGIN_STORE_MAX_LIST, PLUGIN_STORE_MAX_QUOTA_BYTES, PLUGIN_STORE_MAX_VALUE_BYTES, type PluginEventType, type PluginHostScope, type PluginManifest, type PluginRuntime, type PluginToolEffect } from '@/shared/plugin-package';
import { MAX_RESULT_CHARS } from '../contributions/call';
import { CONTEXT_TIMEOUT_MS, MAX_CONTEXT_CHARS } from '../contributions/context';
import { CRON_FIELDS } from '../contributions/cron';
import { MAX_IN_FLIGHT, RATE_PER_MINUTE } from '../contributions/events';
import { MAX_PROMPT_CHARS } from '../contributions/prompt';
import { MAX_CONCURRENT_RUNS } from '../contributions/schedules';
import { SIGNATURE_FILE } from '../integrity';
import { manifestSchema, settingEnvName } from '../manifest';
import { defaultMaxProtection } from '../service';
import { MAX_CONTRIBUTION_INPUT_CHARS } from '../manifest-contributions';
import { MAX_TOKEN_TTL_MS } from '../host-api';
import { DEFAULT_RUN_ROLE, MAX_RUN_OUTPUT_CHARS, MAX_RUNS_IN_FLIGHT, PLUGIN_RUN_TOOL_IDS, RUN_BURST, RUN_TIMEOUT_MS, RUNS_PER_HOUR } from '../host-agent';
import { MAX_DOCUMENT_CHARS } from '../host-documents';
import { MODEL_CALLS_PER_MINUTE } from '../host-model';
import { MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES } from '../tree';
import { pluginDevToolName } from './names';
import { listTemplates } from './templates';

export { PLUGIN_DEV_TOOL_ID, PLUGIN_DEV_TOOLS, pluginDevToolName } from './names';


/** What each effect means to the host. Keyed by the constant: a new effect does not compile until it is described here. */
const EFFECTS: Record<PluginToolEffect, string> = {
  read: 'Reads only (its own cache in the data directory is fine). ALLOW by default; a user rule can make it ask or deny. Context tools must be read.',
  write: 'Changes data in the system it connects to. ASK by default; unattended (schedules, events) it runs only under an ALLOW rule of the user it runs as.',
  external: 'An effect outside the organisation: a payment, a message to a person, a post. Always ASK; a rule can deny but never allow it; never runs unattended.',
};

const EVENTS: Record<PluginEventType, string> = {
  'chat.response': 'A root turn answered. { event: { type, at, userId, sessionId } }',
  'document.completed': 'An uploaded document was processed. { event: { type, at, userId, documentId } }',
  'document.failed': 'Processing an uploaded document failed. { event: { type, at, userId, documentId } }',
};

/**
 * What each host API scope does, its endpoint and rules. Keyed by the
 * constant: a new scope does not compile until it is described here.
 */
const HOST_SCOPES: Record<PluginHostScope, string> = {
  'notes:read': 'GET /api/plugin-host/notes?limit=&tag= → { notes }: the user\'s notes in the call\'s workspace (at most 100), bodies included.',
  'notes:write': 'POST /api/plugin-host/notes { title, body?, tags? } → { id, slug }: creates a note; never overwrites (409 exists).',
  'tasks:read': 'GET /api/plugin-host/tasks?status= → { tasks, withheld }: the user\'s own tasks; those above maxProtection are left out.',
  'tasks:write': 'POST /api/plugin-host/tasks { title, notes?, priority?, dueAt?, category?, link?: { url, label? } } → { id, title, status }.',
  'documents:read': 'GET /api/plugin-host/documents/:id → { id, name, mimeType, text, protectionLevel, … }: one document within maxProtection (403 protection_level above it).',
  'documents:write': `POST /api/plugin-host/documents { name, content, mimeType?: "text/markdown"|"text/plain", category?, summary?, protectionLevel? } → { id, name, protectionLevel, size }: a text document of the user's, in the call's workspace (a space's role rules apply), at least at the level of what the call read; its metadata records { source: "plugin", sourceRef: { plugin, tool } }. PUT /api/plugin-host/documents/:id { content, name?, summary? } replaces the content of a document this package created (403 not_created_by_plugin for any other, 403 protection_level above maxProtection); the level only rises. Content at most ${MAX_DOCUMENT_CHARS} characters. A write tool only.`,
  notify: 'POST /api/plugin-host/notify { title, body? } → { ok }: a notification to the calling user only.',
  'web:read': 'POST /api/plugin-host/web/read { url } → the clean article { url, title, textContent, contentHtml, … }: fetched by the host through its SSRF guard (422 blocked / fetch_failed, nothing else said).',
  'model:complete': `POST /api/plugin-host/model/complete { system?, prompt, maxTokens?, temperature? } → { output, model }: one completion on the user's "everyday" lane; at most ${MODEL_CALLS_PER_MINUTE} a minute, a daily token allowance, the user's spend budgets.`,
  'store:read': `GET /api/plugin-host/store/<key> → { value, version } (404 not_found): one entry of the package's store for the calling user, in the workspace the call ran in. GET /api/plugin-host/store?prefix=&limit= → { keys: [{ key, size, version, updatedAt }], truncated }: the user's keys, sorted (limit default 100, at most ${PLUGIN_STORE_MAX_LIST}). Reading an entry raises the call's protection level to the level it was written at; an entry above maxProtection is not there for the package (404, left out of a list).`,
  'store:write': `PUT /api/plugin-host/store/<key> { value, ifVersion? } → { version }: writes one entry for the calling user only, in the call's workspace, at the call's protection level (the calling session's included; an overwrite never lowers it); with ifVersion only if the entry is at that version now (0: only if it does not exist), else 409 version_conflict { current }. DELETE /api/plugin-host/store/<key> → { deleted: true }. A key is 1-200 of A-Z a-z 0-9 . _ : / - with no empty, "." or ".." segment, sent as is in the path; a value is JSON of at most ${PLUGIN_STORE_MAX_VALUE_BYTES} bytes; each entry counts 128 bytes plus its key and value against the declared store.quotaBytes (413 quota), at most ${PLUGIN_STORE_MAX_ENTRIES} entries per user (413 too_many_entries). A write or external tool only.`,
  'mail:read': 'GET /api/plugin-host/mail/accounts → { accounts: [{ id, label, address, canSend }], inbox: { provider, protectionLevel: 4 } | null }: the Mail module\'s mailboxes the call reaches and the connected Gmail or Microsoft 365 inbox. '
    + 'GET /api/plugin-host/mail/messages?source=mail|inbox&accountId=&status=received|sent|draft&unread=true&q=&limit=&cursor= → { messages, next }: newest first, without text (source mail: each at its own protection level, those above maxProtection left out; source inbox: level 4, limit and cursor only). '
    + 'GET /api/plugin-host/mail/messages/:id?source= → the message with its plain text (404 above maxProtection, as a missing one). What is read raises the call\'s level. The connected inbox is the personal workspace\'s only (403 personal_only in a space).',
  'mail:draft': 'POST /api/plugin-host/mail/drafts { source: "mail"|"inbox", accountId?, to?, cc?, subject?, body, replyTo?, replyAll? } → { id, source, protectionLevel }: saves a draft as the user, never sends (source mail: a new message from accountId to to/cc, or a reply to replyTo, which needs mail:read too; at least at the level of what the call read; marked with the package and tool. Source inbox: a reply to replyTo, or a new message to to, stored in the provider\'s drafts). '
    + 'PUT /api/plugin-host/mail/drafts/:id { to?, cc?, subject?, body? } changes a Mail module draft this package created (403 not_created_by_plugin for any other; a reply keeps its recipients). A write or external tool only.',
  'mail:send': 'POST /api/plugin-host/mail/send { the fields of POST mail/drafts } → { id, source }: sends now (source inbox: exactly one recipient, no cc or reply). POST /api/plugin-host/mail/drafts/:id/send sends a Mail module draft this package created, within maxProtection, exactly as checked. One message per approved call (409 one_send_per_call), at most 20 an hour per package and user (429). '
    + 'An external tool only (each call is asked about); at most 50 recipients. Sending carries data out: the package is limited to protection level 1, and a call holding data above that (what it read, or what the calling session holds) may not send (403 read_level).',
  'calendar:read': 'GET /api/plugin-host/calendar/events?from=&to=&limit= → { events: [{ id, provider, title, start, end, allDay, location, description, organizer, attendees, protectionLevel }], providers, partial, truncated, protectionLevel }: the connected calendars (Google, Microsoft 365) between from and to, at most 93 days. '
    + 'Events count as the level an admin sets (plugins.calendarProtectionLevel, default 3): 403 protection_level when that is above maxProtection. Personal workspace only (403 personal_only).',
  'calendar:write': 'POST /api/plugin-host/calendar/events { provider: "google"|"microsoft", title, start, end, allDay, location?, description? } → { id, provider }: creates an event (no attendees: nobody is invited). PUT /api/plugin-host/calendar/events/:id { the same } changes an event this package created (403 not_created_by_plugin otherwise; 409 has_attendees once the user invited someone to it). '
    + 'start and end are ISO times with an offset, or dates for allDay (end exclusive). A call holding data above the calendar\'s level may not write (403 read_level). A write or external tool only; personal workspace only.',
  'agent:run': `POST /api/plugin-host/agent/runs { prompt, role?, title? } → 202 { id, status: "running", role }: a background run of the host's own agent as the user (role default "${DEFAULT_RUN_ROLE}", any role but general; its tools narrowed to ${PLUGIN_RUN_TOOL_IDS.join(', ')}), unattended, in a session of its own; starting needs a write or external tool. GET /api/plugin-host/agent/runs/:id → { id, status: running|done|error|interrupted, role, title, stage, output, withheld?, error, tokens, startedAt, finishedAt } for a run of this package and user (404 otherwise); output is the final text (at most ${MAX_RUN_OUTPUT_CHARS} characters), withheld above maxProtection. Bounds: ${RUN_BURST} starts in a burst and ${RUNS_PER_HOUR} an hour per package and user, ${MAX_RUNS_IN_FLIGHT} running at once, plugins.hostAgentRunTokens tokens a run (counted in the daily plugin allowance), the user's spend budgets, ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes. Personal workspaces only (409 space). The package keeps the id and polls with a later call: no token outlives its call.`,
};

const RUNTIMES: Record<PluginRuntime, string> = {
  package: 'An MCP server over stdio, in the sandbox. The only runtime an agent may install.',
  'in-process': 'A module loaded into the server process. Never installable by an agent: an admin installs and approves it separately.',
};

/** The manifest's JSON schema, from the zod schema an install parses with. */
export function manifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(manifestSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}

export interface PluginApiContract {
  apiVersion: string;
  manifestFile: string;
  manifestSchema: Record<string, unknown>;
  /** The checks the schema alone does not express. */
  manifestRules: string[];
  defaultMaxProtection: { rule: string; examples: Record<string, number> };
  /** Model calls on CLI lanes and the manifest's `model.trustedInput`. */
  modelCalls: { cliLanes: string; trustedInput: string };
  /** The host API: how a call reaches it, and what each scope in `host` does. */
  hostApi: { reach: string; token: string; effects: string; scopes: Record<PluginHostScope, string> };
  runtimes: Record<PluginRuntime, string>;
  toolEffects: Record<PluginToolEffect, string>;
  contributions: Record<string, unknown>;
  limits: Record<string, number>;
  mcp: Record<string, unknown>;
  environment: Record<string, unknown>;
  sandbox: Record<string, unknown>;
  contentPinning: Record<string, unknown>;
  templates: Awaited<ReturnType<typeof listTemplates>>;
  install: Record<string, unknown>;
  tools: Record<string, string>;
}

/**
 * The live contract. `canInstall`: whether the caller may use
 * `plugin_install` (admins only); `network`: how this host holds a package's
 * network now, with and without declared hosts (`networkStatus` of the service).
 */
export async function pluginApiContract(opts: {
  canInstall: boolean;
  network: (m: PluginManifest) => { state: string; detail: string };
  adminPage: string;
  /** Whether shell commands run sandboxed here (default: what the shell tool would do now). */
  shellSandboxed?: boolean;
}): Promise<PluginApiContract> {
  const example = (hosts: string[]) => opts.network({ name: 'example', version: '0.0.0', apiVersion: PLUGIN_PACKAGE_API_VERSION, title: 'x', description: 'x', network: hosts });
  return {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    manifestFile: PLUGIN_MANIFEST_FILE,
    manifestSchema: manifestJsonSchema(),
    manifestRules: [
      `apiVersion: the same MAJOR as ${PLUGIN_PACKAGE_API_VERSION} and a MINOR no newer.`,
      'runtime "package" (the default) requires server and tools; entry is only for "in-process".',
      'name: not octipus, mcp, system or plugin.',
      'Every tool the server offers must be declared in tools with its effect; an undeclared tool is hidden and refused.',
      'commands, schedules, events and context name one of the package\'s own declared tools; context\'s tool must be "read".',
      'Command names and schedule ids are unique in the package; a command name may not be taken by Octipus, an extension or another installed package.',
      `prompt.file: a .md file inside the package (no .., no link out), at most ${MAX_PROMPT_CHARS} characters; not the manifest or ${SIGNATURE_FILE}.`,
      `server.command and server.args may not name ${SIGNATURE_FILE}; files they name must be in the package.`,
      'A setting may not collide with a secret: setting <key> becomes the variable OCTIPUS_SETTING_<KEY>.',
      `store: { "quotaBytes"?: n } declares the per-user store (default ${PLUGIN_STORE_DEFAULT_QUOTA_BYTES} bytes, at most ${PLUGIN_STORE_MAX_QUOTA_BYTES} per user); it needs the host scope store:read and/or store:write, and those scopes need it.`,
      'maxProtection: the highest protection level (1-4) of a conversation that may call the package; a call from one above it is refused. Left out, it is derived (see defaultMaxProtection).',
      `model.trustedInput: leave it out (the default is untrusted). Set it to true only when every prompt the package sends to model:complete is built from its own constants or from sources the admin trusts, never from web pages, mail, files, user text or other outside data. It needs the host scope model:complete and a model.reason (at most ${MAX_MODEL_TRUST_REASON_CHARS} characters, shown to the admin); it is refused with web:read and for runtime "in-process".`,
    ],
    defaultMaxProtection: {
      rule: 'When maxProtection is left out: 1 if the package has network hosts, the host scope web:read, agent:run or mail:send (each can carry data out), otherwise 4. A package with ui pages sees level 1 whatever it declares (a page can send what it shows to any website); so does one granted web:read, model:complete, agent:run or mail:send.',
      // Computed by the function the server uses, so the rule above cannot drift from it unnoticed (a unit test compares them).
      examples: {
        nothing: defaultMaxProtection({}),
        networkHosts: defaultMaxProtection({ network: ['api.example.com'] }),
        hostWebRead: defaultMaxProtection({ host: ['web:read'] as PluginManifest['host'] }),
        hostAgentRun: defaultMaxProtection({ host: ['agent:run'] as PluginManifest['host'] }),
        hostMailSend: defaultMaxProtection({ host: ['mail:send'] as PluginManifest['host'] }),
        uiPages: defaultMaxProtection({ ui: { pages: [{ path: 'main', title: 'Main', entry: 'index.html' }] } as PluginManifest['ui'] }),
        uiPagesDeclared4: defaultMaxProtection({ maxProtection: 4, ui: { pages: [{ path: 'main', title: 'Main', entry: 'index.html' }] } as PluginManifest['ui'] }),
      },
    },
    modelCalls: {
      cliLanes: 'A model:complete call is refused (409 cli_model) when the user\'s "everyday" lane is bound to a CLI model: a CLI agent has its own tools (shell, files) and runs as the Octipus server user, so a prompt carrying outside data could steer it.',
      trustedInput: `model: { "trustedInput": true, "reason": "<why the prompts carry no outside data>" } asks for the one exception. It grants nothing by itself: an admin approves ${PLUGIN_MODEL_CLI_TOOLS_APPROVAL} explicitly (an upgrade clears it); until then the call is refused as above. Network hosts and *:read host scopes are allowed with it, but the admin is warned that they reach the prompts.`,
    },
    hostApi: {
      reach: `With approved host scopes, each tools/call a user started (their agent's call, a slash command, a button on the package's page) carries _meta["${PLUGIN_HOST_META_KEY}"] = { url, token, expiresAt, scopes }. Call http://${PLUGIN_HOST_ALIAS}/api/plugin-host/… with Authorization: Bearer <token>, through the egress proxy (HTTP_PROXY, an absolute-form request). Schedules, events and context calls get no token.`,
      token: `Minted for the one call, at most ${MAX_TOKEN_TTL_MS / 1000} seconds, revoked when the call returns; it acts as the calling user in their workspace, with declared ∩ approved ∩ the tool's effect ∩ what the user holds. Work that takes longer is an agent:run run, read by its id in a later call.`,
      effects: `A read tool never gets ${PLUGIN_HOST_WRITE_SCOPES.join(', ')}. ${PLUGIN_HOST_START_SCOPES.join(', ')}: a read tool reads, starting needs a write or external tool.`,
      scopes: HOST_SCOPES,
    },
    runtimes: RUNTIMES,
    toolEffects: EFFECTS,
    contributions: {
      commands: `"/name args" calls the tool as the user who typed it, without a model turn; input's "$args" strings are replaced by the text after the command (default input { "text": "<args>" }). The tool's text is the answer, cut to ${MAX_RESULT_CHARS} characters.`,
      schedules: 'The cron runner calls the tool with input (or {}) as the admin who installed the package, unattended.',
      cron: {
        syntax: 'Five fields in UTC; each *, a number, a range a-b, a step */n or a-b/n, or a comma list. Day of week 0-7, Sunday is 0 or 7.',
        fields: CRON_FIELDS.map((f) => ({ name: f.name, min: f.min, max: f.max })),
        examples: ['*/15 * * * *', '15 2 * * *', '0 8 * * 1-5'],
      },
      events: EVENTS,
      prompt: 'Static markdown added to the system prompt of the named roles (all when left out) while the package is enabled.',
      context: `A read tool called before every turn with { query, role }; its text (at most ${MAX_CONTEXT_CHARS} characters, ${CONTEXT_TIMEOUT_MS} ms) rides the turn. Not in spaces or group threads.`,
    },
    limits: {
      maxPromptChars: MAX_PROMPT_CHARS,
      maxContextChars: MAX_CONTEXT_CHARS,
      contextTimeoutMs: CONTEXT_TIMEOUT_MS,
      maxCommandResultChars: MAX_RESULT_CHARS,
      maxContributionInputChars: MAX_CONTRIBUTION_INPUT_CHARS,
      eventsPerMinute: RATE_PER_MINUTE,
      eventsInFlight: MAX_IN_FLIGHT,
      scheduleCallsInFlight: MAX_CONCURRENT_RUNS,
      maxPackageBytes: MAX_PACKAGE_BYTES,
      maxPackageFiles: MAX_PACKAGE_FILES,
      maxSecretLength: MAX_PLUGIN_SECRET_LENGTH,
      defaultRequestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    },
    mcp: {
      transport: 'stdio: newline-delimited JSON-RPC 2.0 messages on stdin/stdout, one per line. Log to stderr, never to stdout.',
      protocolVersion: MCP_PROTOCOL_VERSION,
      start: 'server.command with server.args, run in the package directory.',
      hostCalls: [
        'initialize { protocolVersion, capabilities, clientInfo } → { protocolVersion, capabilities: { tools: {} }, serverInfo }',
        'notifications/initialized (a notification: no id, no answer)',
        'tools/list → { tools: [{ name, description, inputSchema }], nextCursor? } (followed while nextCursor is set)',
        'tools/call { name, arguments } → { content: [{ type: "text", text }], isError? }',
        'shutdown → {} (before the host stops the process; then stdin closes)',
      ],
      errors: 'A failed tool answers a result with isError: true and the reason as text; an unknown method answers a JSON-RPC error (-32601).',
      timeout: `Each request has ${DEFAULT_REQUEST_TIMEOUT_MS} ms unless server.requestTimeoutMs says otherwise.`,
    },
    environment: {
      fromHost: [...MINIMAL_ENV_NAMES],
      dataDir: 'OCTIPUS_PLUGIN_DATA_DIR: the package\'s own writable directory, kept across restarts and upgrades, removed on uninstall. It is SHARED BY ALL USERS of the install: never keep a user\'s data there (a later call for another user could read it). Keep per-user data in the store (store:read, store:write), which the host keeps apart for each user.',
      settings: `Each setting as ${settingEnvName('<key>')} (the key upper-cased), when it has a value.`,
      secrets: 'Each secret under its own key, when an admin has set it.',
      proxy: `With network hosts: ${Object.keys(proxyEnv('http://127.0.0.1:0')).join(', ')} point at the egress proxy (NO_PROXY cleared).`,
      nothingElse: 'No other host variable: no provider keys, no master key, no database URL.',
    },
    sandbox: {
      files: 'The package directory is read-only and its data directory the only writable one (a private /tmp besides).',
      network: 'Only the declared hosts, through the egress proxy: an exact name, *.example.com for its subdomains (not the apex), on 443 and 80 unless a port is given. Addresses that resolve to private, loopback or link-local ranges are refused.',
      // plugins.sandbox (the plugin server's sandbox) and the runner that works here; the shell's is apart.
      plugins: pluginSandboxView(),
      shellMode: getSandboxMode(),
      // Whether the shell tool's commands run in a sandbox on this host: only then may an agent start its server locally to test it.
      shellCommandsSandboxed: opts.shellSandboxed ?? activeSandboxRunner() !== null,
      thisHostWithHosts: example(['api.example.com']),
      thisHostWithoutHosts: example([]),
    },
    contentPinning: {
      rule: 'Every file of the package is hashed at install; the server starts only while its files still hash to the approved content hash. Writing into the package directory makes it "modified" and stops it until an admin approves again.',
      signatureFile: SIGNATURE_FILE,
    },
    templates: await listTemplates(),
    install: {
      youCanInstall: opts.canInstall,
      who: 'Only an admin\'s agent may install, and the admin approves the call. Anyone may validate.',
      what: 'A package-runtime directory inside your own workspace, copied and hashed; installed DISABLED. Octipus does not start it until an admin reviews the content hash and enables it.',
      upgrade: 'upgrade: true replaces a package an agent of the same user installed (it is disabled again); never one a person or another user\'s agent installed, nor a name of a plugin shipped with Octipus.',
      adminPage: opts.adminPage,
      enable: 'There is no tool to enable or approve: an admin does it on the admin page or with `octi plugin` (PATCH /api/plugin-packages/<name> { "enabled": true }).',
    },
    tools: {
      [pluginDevToolName('api')]: 'This contract.',
      [pluginDevToolName('template')]: 'A template\'s files, to write into your workspace with the filesystem tool and edit.',
      [pluginDevToolName('validate')]: 'Check a plugin directory in your workspace: every problem an install would refuse, without installing.',
      [pluginDevToolName('install')]: 'Install a validated package from your workspace, disabled, for an admin to review and enable (asks for approval; admins only).',
    },
  };
}
