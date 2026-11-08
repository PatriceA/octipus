/**
 * Convert a legacy in-process plugin (`extensions/<name>/plugin.json` + an
 * index module, docs/PLUGINS.md) into a plugin package (`octipus-plugin.json`
 * + a local MCP server, docs/PLUGIN-PACKAGES.md).
 *
 * The legacy loader runs a plugin's handlers inside the server with its full
 * rights; a package runs them in its own process, with a minimal environment,
 * declared effects and, when the sandbox is on, a fenced directory. The
 * converter wraps the legacy handlers rather than rewriting them:
 *
 *   <out>/octipus-plugin.json   the package manifest (checked by `parseManifest`)
 *   <out>/package.json          `"type": "module"`, so Node reads the server as ESM
 *   <out>/server.mjs            a generated, dependency-free MCP server over stdio
 *   <out>/legacy/               a copy of the legacy plugin directory
 *
 * The server imports `legacy/<main>`, calls its `initialize` with a logger
 * that reports over MCP (`notifications/message`, never stderr: the host reads
 * stderr as a transport error) and an empty config, exactly as the legacy
 * loader did, and dispatches `tools/call` to `module.tools[name]`.
 *
 * What it refuses, with every problem listed at once: a plugin that needs the
 * host (value imports of `@/…` or `@octipus/…`, the agent hook registry, the
 * vault, imports reaching outside its directory), declared `secrets` (vault
 * access, which a package gets only through its own declared secrets), network
 * use without declared hosts, names or parameter types the package format
 * cannot carry, and entry files plain Node cannot load.
 *
 * Every tool gets the most conservative effect (`external`: always ASK, never
 * unattended) unless the caller says otherwise; the author lowers it after
 * reading the handler.
 */
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { checkApiVersion, manifestTools, type PluginManifest as LegacyManifest, type PluginToolParam, validateManifest } from '@octipus/plugin-sdk';
import {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_TOOL_EFFECTS,
  type PluginManifest,
  type PluginToolEffect,
} from '@/shared/plugin-package';
import { importModuleAt } from '@/utils/import-module';
import { ManifestError, parseManifest } from './packages/manifest';

/** The CLI that does this, named in the legacy loader's deprecation warning. */
export const CONVERT_COMMAND = 'octi plugin convert';

/** Where the copy of the legacy plugin lives inside the package. */
export const LEGACY_SUBDIR = 'legacy';

/** The effect every tool gets unless told otherwise: the strictest there is. */
export const DEFAULT_EFFECT: PluginToolEffect = 'external';

export interface ConvertOptions {
  /** Output directory; created if missing, refused if it exists and is not empty. Default `<cwd>/<name>-package`. */
  outDir?: string;
  /** Per-tool effect overrides, e.g. `{ greet: 'read' }`. Every other tool is `external`. */
  effects?: Record<string, PluginToolEffect>;
  /** Hosts the plugin talks to, added to any the legacy manifest declares in `network`. */
  network?: string[];
  /**
   * Import the legacy module to check that every declared tool has a handler.
   * That runs the module's top-level code (not its `initialize`) in this
   * process, with the caller's environment and no sandbox, so it is off by
   * default: converting a plugin you have not read yet must not run it. When
   * off, the generated server reports a missing handler at call time.
   */
  checkHandlers?: boolean;
}

export interface ConvertResult {
  outDir: string;
  manifest: PluginManifest;
  /** The JSON Schema of each tool's input, as the server lists it. */
  inputSchemas: Record<string, JsonSchemaObject>;
  /** Notes worth reading before installing (nothing here blocked the conversion). */
  warnings: string[];
}

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

/** The conversion was refused; `problems` lists every reason. */
export class ConvertError extends Error {
  constructor(readonly problems: string[]) {
    super(`cannot convert: ${problems.join('; ')}`);
    this.name = 'ConvertError';
  }
}

const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
/** Entry files plain Node runs: JS as is, TS through its built-in type stripping (Node 22.18+). */
const ENTRY_EXTENSIONS = CODE_EXTENSIONS;
const SKIP_DIRS = new Set(['node_modules', '.git']);
/** Files scanned at most; a legacy plugin is a handful of modules. */
const MAX_SCANNED_FILES = 500;

/** Convert a legacy flat parameter map into a JSON Schema object. */
export function toJsonSchema(params: Record<string, PluginToolParam>, tool: string, problems: string[] = []): JsonSchemaObject {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [key, def] of Object.entries(params ?? {})) {
    if (!def || typeof def !== 'object') {
      problems.push(`tool "${tool}": parameter "${key}" is not an object`);
      continue;
    }
    if (!JSON_SCHEMA_TYPES.has(def.type)) {
      problems.push(`tool "${tool}": parameter "${key}" has type "${def.type}", which has no JSON Schema equivalent (use ${[...JSON_SCHEMA_TYPES].join(', ')})`);
      continue;
    }
    const prop: Record<string, unknown> = { type: def.type };
    if (typeof def.description === 'string' && def.description) prop.description = def.description;
    if (def.default !== undefined) prop.default = def.default;
    properties[key] = prop;
    if (def.required === true) required.push(key);
  }
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
}

interface ScannedImport {
  file: string;
  specifier: string;
  typeOnly: boolean;
}

/** Every static, re-export, dynamic and `require` specifier in one source file. */
function importsIn(file: string, source: string): ScannedImport[] {
  const found: ScannedImport[] = [];
  const statement = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(statement)) found.push({ file, specifier: m[3], typeOnly: Boolean(m[2]) });
  const bare = /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(bare)) found.push({ file, specifier: m[1], typeOnly: false });
  const dynamic = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of source.matchAll(dynamic)) found.push({ file, specifier: m[1], typeOnly: false });
  return found;
}

const NETWORK_PATTERNS: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bnew\s+WebSocket\s*\(/, 'WebSocket'],
  [/['"](?:node:)?(?:http|https|http2|net|tls|dgram)['"]/, 'a Node network module'],
  [/['"](?:axios|undici|node-fetch|got|ws|ky|superagent)['"]/, 'an HTTP client package'],
];

const HOST_PATTERNS: Array<[RegExp, string]> = [
  [/\bgetAgentHooks\s*\(/, 'registers a root agent hook (getAgentHooks), which needs the host process'],
  [/\bgetVault\s*\(/, 'reads the vault (getVault), which a package reaches only through its declared secrets'],
];

async function codeFiles(root: string, problems: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        problems.push(`${relative(root, path)} is a symbolic link; a package install refuses links (copy the target in)`);
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path);
        continue;
      }
      if (CODE_EXTENSIONS.has(extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
        if (out.length >= MAX_SCANNED_FILES) {
          // A partial scan would pass imports and network use it never read.
          if (!problems.some((p) => p.startsWith('more than '))) problems.push(`more than ${MAX_SCANNED_FILES} code files; the source scan would be incomplete (convert a smaller plugin, or package it by hand)`);
          return;
        }
        out.push(path);
      }
    }
  };
  await walk(root);
  return out;
}

interface SourceFindings {
  networkUse: string[];
  warnings: string[];
}

/** Read the plugin's own sources for what a package cannot provide. */
async function scanSources(root: string, problems: string[]): Promise<SourceFindings> {
  const networkUse = new Set<string>();
  const warnings = new Set<string>();
  for (const file of await codeFiles(root, problems)) {
    const rel = relative(root, file);
    const source = await readFile(file, 'utf8');
    for (const imp of importsIn(rel, source)) {
      if (imp.typeOnly) continue; // erased: `import type` never runs
      const s = imp.specifier;
      if (s.startsWith('@/')) {
        problems.push(`${rel} imports host internals ("${s}"); a package runs outside the server and cannot reach them`);
      } else if (s.startsWith('@octipus/')) {
        problems.push(`${rel} imports "${s}" at runtime; it resolves only inside the Octipus checkout (use \`import type\`, or bundle what you need)`);
      } else if (s.startsWith('.')) {
        const target = resolve(dirname(file), s);
        if (target !== root && !target.startsWith(root + sep)) {
          problems.push(`${rel} imports "${s}", outside the plugin directory; the package carries only the plugin's own files`);
        } else if (!extname(s)) {
          problems.push(`${rel} imports "${s}" without a file extension; plain Node (which runs the package) needs it, e.g. "${s}.ts"`);
        }
      } else if (/^(?:node:)?child_process$/.test(s)) {
        warnings.add(`${rel} starts processes (child_process); in the sandbox they see only the package directory`);
      }
    }
    for (const [re, label] of HOST_PATTERNS) if (re.test(source)) problems.push(`${rel} ${label}`);
    for (const [re, label] of NETWORK_PATTERNS) if (re.test(source)) networkUse.add(`${rel}: ${label}`);
    if (/\bprocess\.env\b/.test(source)) {
      warnings.add(`${rel} reads process.env; a package sees only PATH, HOME, locale and temp variables plus its own settings and secrets`);
    }
    if (/\b(?:process\.stdout\.write|console\.log)\b/.test(source)) {
      warnings.add(`${rel} writes to stdout; console output is forwarded as MCP log messages, but a direct process.stdout.write would corrupt the protocol`);
    }
  }
  return { networkUse: [...networkUse], warnings: [...warnings] };
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}

/**
 * Convert the legacy plugin in `legacyDir` into a plugin package. Throws
 * `ConvertError` listing every reason it cannot, before writing anything.
 */
export async function convertLegacyPlugin(legacyDir: string, options: ConvertOptions = {}): Promise<ConvertResult> {
  const root = resolve(legacyDir);
  const problems: string[] = [];
  const warnings: string[] = [];

  // 1. The legacy manifest, by the legacy contract.
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConvertError([code === 'ENOENT' ? `no plugin.json in ${root}` : `plugin.json is not valid JSON: ${(err as Error).message}`]);
  }
  const validation = validateManifest(raw);
  if (!validation.ok) throw new ConvertError(validation.errors.map((e) => `plugin.json: ${e}`));
  const legacy: LegacyManifest = validation.manifest;
  const api = checkApiVersion(legacy.apiVersion);
  if (!api.ok) problems.push(`plugin.json: ${api.reason}`);

  // 2. What the package format cannot carry.
  if (legacy.secrets && Object.keys(legacy.secrets).length) {
    problems.push(`plugin.json declares secrets (${Object.keys(legacy.secrets).join(', ')}), read from the vault per calling user; a package declares its own secrets, set by an admin and handed over as environment variables — convert by hand and read them from process.env`);
  }
  const caps = legacy.capabilities;
  if (caps?.commands?.length) warnings.push(`capabilities.commands (${caps.commands.map((c) => c.name).join(', ')}) are not carried over: the legacy host never read them either`);
  if (caps?.events?.length) warnings.push(`capabilities.events (${caps.events.join(', ')}) are not carried over: the legacy host never read them either`);

  const ext = extname(legacy.main);
  if (!ENTRY_EXTENSIONS.has(ext)) {
    problems.push(`main "${legacy.main}": plain Node cannot load a ${ext || 'extension-less'} entry (use .ts, .mts, .js or .mjs)`);
  }
  const entryRel = legacy.main.replace(/^\.\//, '');
  const entryPath = resolve(root, entryRel);
  if (!entryPath.startsWith(root + sep)) problems.push(`main "${legacy.main}" is outside the plugin directory`);

  const tools = manifestTools(legacy);
  if (!tools.length) problems.push('plugin.json declares no tools; a package needs at least one');
  const inputSchemas: Record<string, JsonSchemaObject> = {};
  const effects: Record<string, { effect: PluginToolEffect; description?: string }> = {};
  for (const t of tools) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) {
      problems.push(`tool "${t.name}": an MCP tool name is letters, digits, _ and - (at most 64)`);
      continue;
    }
    if (inputSchemas[t.name]) {
      problems.push(`tool "${t.name}" is declared twice`);
      continue;
    }
    inputSchemas[t.name] = toJsonSchema(t.parameters, t.name, problems);
    const effect = options.effects?.[t.name] ?? DEFAULT_EFFECT;
    if (!PLUGIN_TOOL_EFFECTS.includes(effect)) problems.push(`tool "${t.name}": effect "${effect}" is not one of ${PLUGIN_TOOL_EFFECTS.join(', ')}`);
    effects[t.name] = { effect, ...(t.description ? { description: t.description.slice(0, 500) } : {}) };
  }
  for (const name of Object.keys(options.effects ?? {})) {
    if (!tools.some((t) => t.name === name)) problems.push(`effect given for "${name}", which the plugin does not declare`);
  }

  // 3. Its sources.
  const findings = await scanSources(root, problems);
  warnings.push(...findings.warnings);
  const declaredNetwork = Array.isArray(raw.network) ? raw.network.filter((h): h is string => typeof h === 'string') : [];
  const network = [...new Set([...declaredNetwork, ...(options.network ?? [])])];
  if (findings.networkUse.length && !network.length) {
    problems.push(`the plugin uses the network (${findings.networkUse.join('; ')}) but declares no hosts; pass them with --network <host> so the package can say what it talks to`);
  }

  // 4. The handlers, when they can be checked.
  if (options.checkHandlers === true && !problems.length) {
    try {
      const imported = await importModuleAt(entryPath);
      const mod = (imported.default ?? imported) as { tools?: Record<string, unknown> };
      if (!mod || typeof mod !== 'object' || typeof mod.tools !== 'object' || !mod.tools) {
        problems.push(`${entryRel}: the default export has no "tools" object`);
      } else {
        for (const t of tools) if (typeof mod.tools[t.name] !== 'function') problems.push(`tool "${t.name}" has no handler in ${entryRel}`);
      }
    } catch (err) {
      problems.push(`${entryRel} could not be imported: ${(err as Error).message}`);
    }
  }

  // 5. The manifest, by the package contract.
  const manifest = {
    name: legacy.name,
    version: legacy.version,
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    title: legacy.name,
    description: legacy.description?.trim() || `${legacy.name} (converted from a legacy plugin)`,
    ...(legacy.author ? { publisher: legacy.author.slice(0, 200) } : {}),
    server: { command: 'node', args: ['server.mjs'] },
    tools: effects,
    network,
    // A package that talks to hosts may see only level-1 data; one with no
    // network, the host's own default for that case (docs/PLUGIN-PACKAGES.md).
    maxProtection: network.length ? 1 : 4,
  };
  let parsed: PluginManifest | undefined;
  try {
    parsed = parseManifest(manifest);
  } catch (err) {
    if (!(err instanceof ManifestError)) throw err;
    problems.push(...err.problems.map((p) => `generated ${PLUGIN_MANIFEST_FILE}: ${p}`));
  }
  if (problems.length || !parsed) throw new ConvertError(problems);

  // A link under node_modules (other than its .bin shims, which are not
  // copied) would be copied as a link and refused at install.
  for (const link of await linksUnder(join(root, 'node_modules'), root)) {
    problems.push(`${link} is a symbolic link; a package install refuses links (vendor the dependency without links, e.g. npm install --install-links)`);
  }
  if (problems.length) throw new ConvertError(problems);
  if (options.checkHandlers !== true) warnings.push(`the handlers were not imported to check them (pass --check-handlers to run ${entryRel} here); a tool without one fails when called`);

  // 6. Write it out.
  const outDir = resolve(options.outDir ?? join(process.cwd(), `${legacy.name}-package`));
  if (outDir === root || outDir.startsWith(root + sep)) throw new ConvertError([`output ${outDir} is inside the legacy plugin directory`]);
  if (!(await isEmptyOrMissing(outDir))) throw new ConvertError([`output ${outDir} exists and is not empty`]);
  await mkdir(outDir, { recursive: true });
  await cp(root, join(outDir, LEGACY_SUBDIR), {
    recursive: true,
    // node_modules stays: the handlers may need it. Only VCS metadata is left behind.
    filter: (src) => basename(src) !== '.git' && !isBinShims(src),
  });
  await writeFile(join(outDir, PLUGIN_MANIFEST_FILE), `${JSON.stringify(parsed, null, 2)}\n`);
  await writeFile(join(outDir, 'package.json'), `${JSON.stringify({ name: `${legacy.name}-package`, version: legacy.version, private: true, type: 'module' }, null, 2)}\n`);
  await writeFile(join(outDir, 'server.mjs'), renderServer({
    name: legacy.name,
    version: legacy.version,
    entry: `./${LEGACY_SUBDIR}/${entryRel.split(sep).join('/')}`,
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchemas[t.name] })),
  }));

  return { outDir, manifest: parsed, inputSchemas, warnings };
}

/** `node_modules/.bin`: links to dependencies' executables, which a server never runs. */
function isBinShims(path: string): boolean {
  return basename(path) === '.bin' && basename(dirname(path)) === 'node_modules';
}

/** Symbolic links under `dir` (relative to `root`), skipping `node_modules/.bin`. */
async function linksUnder(dir: string, root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(d, entry.name);
      if (entry.isSymbolicLink()) out.push(relative(root, path));
      else if (entry.isDirectory() && !isBinShims(path)) await walk(path);
    }
  };
  await walk(dir);
  return out;
}

/** Text safe inside a generated `//` comment: one line. */
const commentText = (text: string) => text.replace(/[\r\n\u2028\u2029]+/g, ' ');

interface ServerSpec {
  name: string;
  version: string;
  entry: string;
  tools: Array<{ name: string; description: string; inputSchema: JsonSchemaObject }>;
}

/**
 * The generated MCP server. Dependency-free, like the package fixtures: an
 * installed package is copied out of the checkout, where no SDK resolves, and
 * the host speaks newline-delimited JSON-RPC over stdio (src/mcp/transports/stdio.ts).
 */
export function renderServer(spec: ServerSpec): string {
  return `// Generated by \`${CONVERT_COMMAND}\` from the legacy plugin "${commentText(spec.name)}" ${commentText(spec.version)}.
// A dependency-free MCP server over stdio (newline-delimited JSON-RPC) that
// dispatches tool calls to the legacy handlers in ${commentText(spec.entry)}.
// Regenerate rather than edit; the effects live in octipus-plugin.json.
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = ${JSON.stringify(spec.name)};
const VERSION = ${JSON.stringify(spec.version)};
// A path, not a URL reference: a '#', '?' or '%' in it stays part of the name.
const ENTRY = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(spec.entry)}));
const TOOLS = ${JSON.stringify(spec.tools, null, 2)};
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// stdout carries the protocol and the host reads stderr as a transport error,
// so logs (the plugin's logger and its console) go out as MCP log messages.
const out = process.stdout.write.bind(process.stdout);
const send = (msg) => out(\`\${JSON.stringify({ jsonrpc: '2.0', ...msg })}\\n\`);
const render = (args) => args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
const emit = (level) => (...args) => send({ method: 'notifications/message', params: { level, logger: NAME, data: render(args) } });
const logger = { trace: emit('debug'), debug: emit('debug'), info: emit('info'), warn: emit('warning'), error: emit('error'), fatal: emit('critical') };
logger.child = () => logger;
console.log = console.info = emit('info');
console.debug = emit('debug');
console.warn = emit('warning');
console.error = emit('error');

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }] });

let plugin;
const ready = (async () => {
  const mod = await import(ENTRY.href);
  plugin = mod.default ?? mod;
  if (!plugin || typeof plugin.tools !== 'object') throw new Error(\`\${fileURLToPath(ENTRY)} has no "tools" object\`);
  await plugin.initialize?.({ logger, config: {} });
})();
ready.catch((err) => logger.error(\`legacy plugin failed to load: \${err?.message ?? err}\`));

export async function handle(msg) {
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
      return { result: { protocolVersion, capabilities: { tools: {}, logging: {} }, serverInfo: { name: NAME, version: VERSION } } };
    }
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: TOOLS } };
    case 'tools/call': {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return { error: { code: -32602, message: \`Unknown tool: \${name}\` } };
      try {
        await ready;
      } catch (err) {
        return { error: { code: -32603, message: \`legacy plugin failed to load: \${err?.message ?? err}\` } };
      }
      const handler = plugin.tools[name];
      if (typeof handler !== 'function') return { error: { code: -32603, message: \`No handler for \${name}\` } };
      try {
        return { result: text(await handler(msg.params?.arguments ?? {}, { config: {} })) };
      } catch (err) {
        return { result: { ...text(\`Plugin tool error: \${err?.message ?? err}\`), isError: true } };
      }
    }
    default:
      return { error: { code: -32601, message: \`Method not found: \${msg.method}\` } };
  }
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await ready;
    await plugin?.shutdown?.();
  } catch {
    // shutting down regardless
  }
  process.exit(0);
}

createInterface({ input: process.stdin })
  .on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (msg.id === undefined || msg.id === null) return; // a notification
    send({ id: msg.id, ...(await handle(msg)) });
  })
  .on('close', stop);
process.on('SIGTERM', stop);
`;
}
