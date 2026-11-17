/**
 * The built-in skill "Write an Octipus plugin" (creator mode,
 * docs/PLUGIN-PACKAGES.md#writing-a-plugin-with-an-agent): the loop an agent
 * follows to write a sandboxed plugin package and hand it to an admin.
 * Seeded as a system skill (src/db/seed-skills.ts); the tool names come from
 * ./names.ts, so the skill names the tools that exist.
 */
import { MCP_PROTOCOL_VERSION } from '@/mcp/protocol';
import { PLUGIN_MANIFEST_FILE } from '@/shared/plugin-package';
import { pluginDevToolName } from './names';

export const PLUGIN_AUTHORING_SKILL_ID = 'octipus-plugin-package';

const api = pluginDevToolName('api');
const template = pluginDevToolName('template');
const validate = pluginDevToolName('validate');
const install = pluginDevToolName('install');

export const PLUGIN_AUTHORING_SKILL_CONTENT = `Use this when the user wants a new capability as an Octipus plugin: a sandboxed plugin package (an MCP server over stdio with declared tools, and optionally slash commands, schedules, events, a prompt section or turn context). You write it in your workspace; an admin reviews and enables it. The source stays in the user's workspace and the installed copy in this install's plugin directory: never in the Octipus repository or its \`plugins/\` directory, which holds only the example plugins. You never install code that runs in the server process (runtime "in-process"), and you cannot enable a plugin.

## The loop

1. **Plan compatibility before building.** Establish the data classification, interface and required capabilities with the user or known project context. Call the API tool with \`needs: {protectionLevel, interface: "page"|"dashboard"|"tools", host: [...]}\` to check that combination; if unsupported, explain it before writing code. Never lower classification to make a page work.
   **Read the contract.** Call \`${api}\`. It is the live source: the manifest JSON schema, rules the schema cannot express, tool effects, events, cron syntax, limits, the MCP stdio contract, the environment variables a package gets, the sandbox and network rules on this host, the templates, and \`install.youCanInstall\`. Do not rely on memory for any of it.
2. **Start from a template.** \`${template}\` lists them; \`${template}\` with \`name\` returns its files. Write every file into one new directory of your workspace with the filesystem tool (e.g. \`my-plugins/<name>/\`). Rename the package: \`name\` in ${PLUGIN_MANIFEST_FILE} (lower-case, digits, \`-\`) and \`NAME\` in server.mjs.
   Use the guided-connection template for reusable host transport and native resource selectors; with-store shows per-user persistence. These template files are returned by the tool; copy them into the new plugin, never edit the template in Octipus itself.
3. **Implement.** Prefer the guided-connection template and its vendored host client. Declare setup.resources for existing connections, folders and environments, and a read-only setup.check returning actual {ok,message} evidence. Never claim connectivity from configuration alone. Keep the server dependency-free (plain \`.mjs\`, Node built-ins) or vendor what it needs inside the package. Every tool the server lists must be declared in \`tools\` with the narrowest true effect: \`read\` reads, \`write\` changes data in the connected system, \`external\` acts outside the organisation (payments, messages to people). Declare every host it talks to in \`network\`; nothing else is reachable under the sandbox. Keep its own state (caches, tokens it refreshes) only in \`OCTIPUS_PLUGIN_DATA_DIR\`; the package directory is read-only and its files are pinned by hash. That data directory is **shared by every user of the install**: never keep a user's data there (notes, preferences, history, anything one user typed or owns), or a later call for another user can read it. Keep per-user data in the store instead (host scopes \`store:read\` and \`store:write\`, with \`store: { "quotaBytes": … }\` in the manifest; the \`with-store\` template shows how): Octipus keeps it for each user apart, and in each workspace apart, on the user and workspace of the call. Credentials are \`secrets\` (an admin sets them), never in files. Log to stderr; stdout carries only JSON-RPC.
4. **Validate.** \`${validate}\` with the directory. Fix every problem and validate again until \`ok\` is true. Read the warnings too.
5. **Test the server, only in a sandboxed shell.** Only if \`sandbox.shellCommandsSandboxed\` in \`${api}\` is true (and you have a shell): starting the server runs the code you wrote, and without the shell sandbox it would run as the Octipus server's user, with its files and network. Otherwise skip this step: do not run the server, rely on \`${validate}\`, and say in the hand-over that the server was not run. From the package directory, with a scratch data directory outside it:
   \`\`\`
   printf '%s\\n' \\
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"${MCP_PROTOCOL_VERSION}","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \\
     '{"jsonrpc":"2.0","method":"notifications/initialized"}' \\
     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \\
     '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"<tool>","arguments":{}}}' \\
     | OCTIPUS_PLUGIN_DATA_DIR="$(mktemp -d)" node server.mjs
   \`\`\`
   Each request must get exactly one line back with its \`id\`; a tool failure is a result with \`isError: true\`. Call every tool once. Remove anything the test wrote into the package directory, then validate again.
6. **Install.** Only if \`install.youCanInstall\` is true: \`${install}\` with the directory (\`upgrade: true\` to replace a version you installed before). The user is asked to approve. It installs the package **disabled** and returns its content hash. If you may not install, stop after step 5 and tell the user where the package is so an admin can install it.
7. **Hand over one setup link.** Use the returned guided setup URL. The user selects existing resources, reviews access and checks readiness there. Do not hand them a list of CLI/PATCH commands, internal IDs or content hashes to copy. Local private use requires no signing key or marketplace publication. Keep marketplace publishing as a separate publisher-only task. You cannot enable or approve a plugin yourself.


## Rules

- Never claim the plugin works or is active before an admin enabled it.
- Never run code of the plugin on the host outside the shell sandbox (step 5).
- Never ask the user to paste a secret into the chat; declare it in \`secrets\` and let the admin set it.
- Never keep one user's data where another user's call can read it: per-user data goes in the store, never in \`OCTIPUS_PLUGIN_DATA_DIR\`.
- A schedule runs unattended as the installing admin: a \`write\` tool needs their ALLOW rule, an \`external\` one never runs. Prefer \`read\` tools for schedules and context.
- Do not write into another installed package, the plugin directory or the Octipus install or repository; work only in your workspace.
- Leave \`model\` out of the manifest. Set \`model.trustedInput\` only when every prompt the plugin sends to \`model:complete\` is built from its own constants or from sources the admin trusts, never from web pages, mail, files, the user's text or other outside data, and give the honest \`reason\`. It lets its model calls run on CLI agents with their own tools, and only after an admin approves it.`;

export const PLUGIN_AUTHORING_SKILL = {
  id: PLUGIN_AUTHORING_SKILL_ID,
  name: 'Write an Octipus plugin',
  category: 'coding',
  description: 'Write a sandboxed Octipus plugin package with the plugin_dev tools: contract, template, validate, test, install disabled for an admin to enable.',
  content: PLUGIN_AUTHORING_SKILL_CONTENT,
  triggers: ['octipus plugin', 'plugin package', 'write a plugin', 'build a plugin', 'create a plugin', 'make a plugin', 'new plugin'],
  principles: [],
  bestPractices: [],
  antiPatterns: [],
  frameworks: ['MCP', 'Octipus plugin packages'],
};
