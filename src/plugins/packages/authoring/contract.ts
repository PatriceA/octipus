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
import { MAX_PLUGIN_SECRET_LENGTH, PLUGIN_MANIFEST_FILE, PLUGIN_PACKAGE_API_VERSION, type PluginEventType, type PluginManifest, type PluginRuntime, type PluginToolEffect } from '@/shared/plugin-package';
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
      'maxProtection: the highest protection level (1-4) of a conversation that may call the package; a call from one above it is refused. Left out, it is derived (see defaultMaxProtection).',
    ],
    defaultMaxProtection: {
      rule: 'When maxProtection is left out: 1 if the package has network hosts, the host scope web:read or ui pages (each can carry data out), otherwise 4.',
      // Computed by the function the server uses, so the rule above cannot drift from it unnoticed (a unit test compares them).
      examples: {
        nothing: defaultMaxProtection({}),
        networkHosts: defaultMaxProtection({ network: ['api.example.com'] }),
        hostWebRead: defaultMaxProtection({ host: ['web:read'] as PluginManifest['host'] }),
        uiPages: defaultMaxProtection({ ui: { pages: [{ path: 'main', title: 'Main', entry: 'index.html' }] } as PluginManifest['ui'] }),
      },
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
      dataDir: 'OCTIPUS_PLUGIN_DATA_DIR: the package\'s own writable directory, kept across restarts and upgrades, removed on uninstall.',
      settings: `Each setting as ${settingEnvName('<key>')} (the key upper-cased), when it has a value.`,
      secrets: 'Each secret under its own key, when an admin has set it.',
      proxy: `With network hosts: ${Object.keys(proxyEnv('http://127.0.0.1:0')).join(', ')} point at the egress proxy (NO_PROXY cleared).`,
      nothingElse: 'No other host variable: no provider keys, no master key, no database URL.',
    },
    sandbox: {
      files: 'The package directory is read-only and its data directory the only writable one (a private /tmp besides).',
      network: 'Only the declared hosts, through the egress proxy: an exact name, *.example.com for its subdomains (not the apex), on 443 and 80 unless a port is given. Addresses that resolve to private, loopback or link-local ranges are refused.',
      mode: getSandboxMode(),
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
