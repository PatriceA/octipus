#!/usr/bin/env tsx
/**
 * `octi plugin <subcommand>` (WS3).
 *
 *   octi plugin validate <dir>   Validate a plugin against the contract.
 *   octi plugin convert <dir>    Convert a legacy plugin into a plugin package.
 *   octi plugin keygen <prefix>  Make an Ed25519 signing key pair.
 *   octi plugin sign <dir> --key <file>  Sign a plugin package (octipus-plugin.sig).
 *   octi plugin sign-index <index.json> --key <file>  Sign a registry index (<index.json>.sig).
 *   octi plugin list             Installed packages (through the running backend).
 *   octi plugin approve <name> [--hash sha256:…]  Approve a package's changed content.
 *   octi plugin approve-in-process <name> [--hash sha256:…]  Approve an in-process plugin to run in the server process.
 *   octi plugin approve-contributions <name> [--hash sha256:…]  Approve what a package adds (commands, schedules, events, prompt, context).
 *   octi plugin set <name> key=value...  Change a package's settings.
 *   octi plugin secret <name> <KEY> [--clear]  Set (from stdin or a hidden prompt) or remove a secret.
 *   octi plugin uninstall <name> [--yes]  Remove a package.
 *   octi plugin bundled          The first-party plugins shipped with Octipus.
 *   octi plugin install-bundled <name> [--upgrade]  Install one (disabled).
 *
 * Delegated from bin/octi.ts. Uses the published validation kit so authors and
 * the host run identical checks.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { validatePlugin } from '@octipus/plugin-sdk/testing';
import { ConvertError, convertLegacyPlugin } from '@/plugins/convert';
import { ManifestError } from '@/plugins/packages/manifest';
import { generateSigningKey, SignatureError, signPackage, signRegistryIndexFile } from '@/plugins/packages/signature';
import { PackageTreeError } from '@/plugins/packages/tree';
import { PLUGIN_TOOL_EFFECTS, type PluginToolEffect } from '@/shared/plugin-package';
import { approveCommand, approveContributionsCommand, approveInProcessCommand, bundledCommand, installBundledCommand, listCommand, type PluginApiIo, readAllText, readHiddenLine, secretCommandFromArgs, setCommand, uninstallCommand } from './plugin-api';

const HELP = `octi plugin — plugin tooling

Usage:
  octi plugin validate <dir>    Validate a plugin directory against the contract
  octi plugin convert <legacy-dir> [--out <dir>] [--effect <tool>=<read|write|external>]... [--network <host>]... [--check-handlers]
                                Convert a legacy plugin (plugin.json) into a plugin
                                package (octipus-plugin.json + MCP server). Every tool
                                is "external" (always ask) unless --effect lowers it.
                                --check-handlers imports the plugin here to check every
                                tool has a handler: that runs its code with your rights.
  octi plugin keygen <out-prefix>
                                Make an Ed25519 key pair: <out-prefix>.key (private,
                                keep it secret) and <out-prefix>.pub (public, for
                                plugins.trustedPublishers). Never overwrites a file.
  octi plugin sign <dir> --key <private-key-file>
                                Sign a plugin package: writes <dir>/octipus-plugin.sig
                                over its content hash. Sign last: any later change to
                                the files invalidates the signature.
  octi plugin sign-index <index.json> --key <private-key-file>
                                Sign a registry index: writes <index.json>.sig over its
                                exact bytes. Publish both side by side; a registry
                                configured with "publisher" lists the index only when
                                the .sig verifies with a trusted key of that publisher.
  octi plugin list              Installed plugin packages: state, signature, network,
                                approved and actual content hash.
  octi plugin approve <name> [--hash sha256:<hex>]
                                Approve a package's changed content. Without --hash it
                                shows the actual hash and asks (at a terminal only).
                                Refused when the files no longer hash to it.
  octi plugin approve-in-process <name> [--hash sha256:<hex>]
                                Approve an in-process plugin (runtime "in-process") to
                                run in the server process, for its approved content
                                hash; needed before it can be enabled, and again after
                                any new content. Without --hash it shows the hash and
                                asks (at a terminal only).
  octi plugin approve-contributions <name> [--hash sha256:<hex>]
                                Approve what a package adds besides tools: slash
                                commands, schedules, event handlers, prompt text in
                                every user's agents, turn context; needed before it can
                                be enabled, and again after an upgrade. Without --hash
                                it shows all of it (the full prompt text) and asks (at
                                a terminal only).
  octi plugin set <name> key=value...
                                Change settings (checked against the manifest; exactly
                                key= clears one). Not for secrets.
  octi plugin secret <name> <KEY> [--clear]
                                Set a secret: the value is read from a prompt that does
                                not echo, or from stdin (octi plugin secret finapi
                                API_TOKEN < token.txt); never from the command line.
                                --clear removes it.
  octi plugin uninstall <name> [--yes]
                                Remove a package, its files, data, settings and secrets.
                                Asks at a terminal; elsewhere refused without --yes.
  octi plugin bundled           The first-party plugins shipped with Octipus (plugins/
                                in the install) and whether each is installed.
  octi plugin install-bundled <name> [--upgrade]
                                Install one, pinned and disabled like any package;
                                enable it on the admin page, approving its host scopes.

list, approve, approve-in-process, approve-contributions, set, secret, uninstall, bundled and install-bundled call the running backend (http://localhost:$API_PORT, 3005 by
default) with the admin API token in OCTIPUS_API_TOKEN (Settings → API Tokens).
`;

async function runKeygen(argv: string[]): Promise<never> {
  if (argv.length !== 1) {
    process.stderr.write(`octi plugin keygen: expected one <out-prefix>\n\n${HELP}`);
    process.exit(2);
  }
  const prefix = resolve(argv[0]);
  const { privateKeyPem, publicKeyPem, keyId } = generateSigningKey();
  try {
    // 'wx': never overwrite a key someone may already have published.
    await writeFile(`${prefix}.key`, privateKeyPem, { flag: 'wx', mode: 0o600 });
    await writeFile(`${prefix}.pub`, publicKeyPem, { flag: 'wx', mode: 0o644 });
  } catch (err) {
    process.stderr.write(`octi plugin keygen: ${(err as Error).message}\n`);
    process.exit(1);
  }
  process.stdout.write(`✅ Wrote ${prefix}.key (private: keep it secret) and ${prefix}.pub\n`);
  process.stdout.write(`   key id: ${keyId}\n\n`);
  process.stdout.write('Trust it on a host with plugins.trustedPublishers:\n');
  process.stdout.write(`${JSON.stringify([{ name: '<publisher name>', publicKey: publicKeyPem.trim() }], null, 2)}\n`);
  process.exit(0);
}

async function runSign(argv: string[]): Promise<never> {
  let values: { key?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { key: { type: 'string', short: 'k' } } }));
  } catch (err) {
    process.stderr.write(`octi plugin sign: ${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (positionals.length !== 1 || !values.key) {
    process.stderr.write(`octi plugin sign: expected <dir> --key <private-key-file>\n\n${HELP}`);
    process.exit(2);
  }
  const dir = resolve(positionals[0]);
  try {
    const { contentHash, keyId, file } = await signPackage(dir, await readFile(resolve(values.key), 'utf8'));
    process.stdout.write(`✅ Signed ${dir}\n   content hash: ${contentHash}\n   key id: ${keyId}\n   wrote ${file}\n`);
    process.exit(0);
  } catch (err) {
    const problems = err instanceof ManifestError ? err.problems : [(err as Error).message];
    if (!(err instanceof ManifestError || err instanceof SignatureError || err instanceof PackageTreeError || err instanceof SyntaxError || (err as NodeJS.ErrnoException).code)) throw err;
    for (const p of problems) process.stderr.write(`  ✗ ${p}\n`);
    process.stderr.write(`\n❌ ${dir} was not signed.\n`);
    process.exit(1);
  }
}

async function runSignIndex(argv: string[]): Promise<never> {
  let values: { key?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { key: { type: 'string', short: 'k' } } }));
  } catch (err) {
    process.stderr.write(`octi plugin sign-index: ${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (positionals.length !== 1 || !values.key) {
    process.stderr.write(`octi plugin sign-index: expected <index.json> --key <private-key-file>\n\n${HELP}`);
    process.exit(2);
  }
  const file = resolve(positionals[0]);
  try {
    const { sigFile, keyId, sha256 } = await signRegistryIndexFile(file, await readFile(resolve(values.key), 'utf8'));
    process.stdout.write(`✅ Signed ${file}\n   index hash: ${sha256}\n   key id: ${keyId}\n   wrote ${sigFile}\n`);
    process.stdout.write('   Publish both files unchanged: any change to the index bytes invalidates the signature.\n');
    process.exit(0);
  } catch (err) {
    if (!(err instanceof SignatureError || (err as NodeJS.ErrnoException).code)) throw err;
    process.stderr.write(`  ✗ ${(err as Error).message}\n\n❌ ${file} was not signed.\n`);
    process.exit(1);
  }
}

function apiIo(): PluginApiIo {
  return {
    fetch,
    env: process.env,
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    readSecret: (prompt) => (process.stdin.isTTY === true
      ? readHiddenLine(process.stdin, (t) => process.stderr.write(t), prompt)
      : readAllText(process.stdin)),
  };
}

function usage(sub: string, expected: string): never {
  process.stderr.write(`octi plugin ${sub}: ${expected}\n\n${HELP}`);
  process.exit(2);
}

async function runApiCommand(sub: 'set' | 'uninstall', argv: string[]): Promise<never> {
  let values: { yes?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: sub === 'uninstall' ? { yes: { type: 'boolean', short: 'y' } } : {},
    }));
  } catch (err) {
    usage(sub, (err as Error).message);
  }
  const io = apiIo();
  switch (sub) {
    case 'set':
      if (positionals.length < 2) usage(sub, 'expected <name> key=value...');
      process.exit(await setCommand(io, positionals[0], positionals.slice(1)));
      break;
    case 'uninstall':
      if (positionals.length !== 1) usage(sub, 'expected <name> [--yes]');
      process.exit(await uninstallCommand(io, positionals[0], values.yes === true));
  }
}

async function runApprove(sub: 'approve' | 'approve-in-process' | 'approve-contributions', argv: string[]): Promise<never> {
  let values: { hash?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { hash: { type: 'string' } } }));
  } catch (err) {
    process.stderr.write(`octi plugin ${sub}: ${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (positionals.length !== 1) {
    process.stderr.write(`octi plugin ${sub}: expected <name> [--hash sha256:<hex>]\n\n${HELP}`);
    process.exit(2);
  }
  const command = sub === 'approve' ? approveCommand : sub === 'approve-in-process' ? approveInProcessCommand : approveContributionsCommand;
  process.exit(await command(apiIo(), positionals[0], values.hash));
}

async function runValidate(dir: string): Promise<never> {
  const abs = resolve(dir);
  const report = await validatePlugin(abs);

  for (const p of report.passed) process.stdout.write(`  ✓ ${p}\n`);
  for (const w of report.warnings) process.stdout.write(`  ⚠ ${w}\n`);
  for (const e of report.errors) process.stderr.write(`  ✗ ${e}\n`);

  if (report.ok) {
    process.stdout.write(`\n✅ ${abs} is a valid plugin${report.warnings.length ? ' (with warnings)' : ''}.\n`);
    process.exit(0);
  }
  process.stderr.write(`\n❌ ${abs} failed validation (${report.errors.length} error(s)).\n`);
  process.exit(1);
}

async function runConvert(argv: string[]): Promise<never> {
  let parsed: ReturnType<typeof parseConvertArgs>;
  try {
    parsed = parseConvertArgs(argv);
  } catch (err) {
    process.stderr.write(`octi plugin convert: ${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  try {
    const result = await convertLegacyPlugin(parsed.dir, { outDir: parsed.out, effects: parsed.effects, network: parsed.network, checkHandlers: parsed.checkHandlers });
    for (const w of result.warnings) process.stdout.write(`  ⚠ ${w}\n`);
    const m = result.manifest;
    process.stdout.write(`\n✅ Wrote the plugin package "${m.name}" ${m.version} to ${result.outDir}\n`);
    for (const [tool, decl] of Object.entries(m.tools ?? {})) process.stdout.write(`  ${tool}: ${decl.effect}\n`);
    process.stdout.write(`  network: ${m.network?.length ? m.network.join(', ') : 'none'}; maxProtection: ${m.maxProtection}\n`);
    process.stdout.write('\nReview the effects (lower one with --effect <tool>=read once you have read its handler),\n'
      + `then install it: POST /api/plugin-packages { "path": "${result.outDir}" }\n`);
    process.exit(0);
  } catch (err) {
    if (!(err instanceof ConvertError)) throw err;
    for (const p of err.problems) process.stderr.write(`  ✗ ${p}\n`);
    process.stderr.write(`\n❌ ${resolve(parsed.dir)} cannot be converted (${err.problems.length} problem(s)).\n`);
    process.exit(1);
  }
}

function parseConvertArgs(argv: string[]): { dir: string; out?: string; effects: Record<string, PluginToolEffect>; network: string[]; checkHandlers: boolean } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      effect: { type: 'string', multiple: true },
      network: { type: 'string', multiple: true },
      'check-handlers': { type: 'boolean' },
    },
  });
  if (positionals.length !== 1) throw new Error(positionals.length ? 'expected one <legacy-dir>' : 'missing <legacy-dir>');
  const effects: Record<string, PluginToolEffect> = {};
  for (const spec of values.effect ?? []) {
    const [tool, effect] = spec.split('=');
    if (!tool || !PLUGIN_TOOL_EFFECTS.includes(effect as PluginToolEffect)) {
      throw new Error(`--effect "${spec}": expected <tool>=${PLUGIN_TOOL_EFFECTS.join('|')}`);
    }
    effects[tool] = effect as PluginToolEffect;
  }
  return { dir: positionals[0], out: values.out, effects, network: values.network ?? [], checkHandlers: values['check-handlers'] === true };
}

async function main(): Promise<void> {
  // The launchers start this from the project directory; paths on the command
  // line (and the default --out) are the user's, relative to where they ran it.
  if (process.env.OCTI_USER_CWD) process.chdir(process.env.OCTI_USER_CWD);
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'validate': {
      const dir = rest[0];
      if (!dir) {
        process.stderr.write('octi plugin validate: missing <dir>\n');
        process.exit(2);
      }
      await runValidate(dir);
      break;
    }
    case 'convert':
      await runConvert(rest);
      break;
    case 'keygen':
      await runKeygen(rest);
      break;
    case 'sign':
      await runSign(rest);
      break;
    case 'sign-index':
      await runSignIndex(rest);
      break;
    case 'list':
      process.exit(await listCommand(apiIo()));
      break;
    case 'approve':
    case 'approve-in-process':
    case 'approve-contributions':
      await runApprove(sub, rest);
      break;
    case 'set':
    case 'uninstall':
      await runApiCommand(sub, rest);
      break;
    case 'bundled':
      process.exit(await bundledCommand(apiIo()));
      break;
    case 'install-bundled': {
      let parsed: { values: { upgrade?: boolean }; positionals: string[] };
      try {
        parsed = parseArgs({ args: rest, allowPositionals: true, options: { upgrade: { type: 'boolean' } } });
      } catch (err) {
        usage(sub, (err as Error).message);
      }
      if (parsed.positionals.length !== 1) usage(sub, 'expected <name> [--upgrade]');
      process.exit(await installBundledCommand(apiIo(), parsed.positionals[0], parsed.values.upgrade === true));
      break;
    }
    case 'secret':
      // Its own parser: a refusal must never echo a value typed on the command line.
      process.exit(await secretCommandFromArgs(apiIo(), rest));
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      process.exit(0);
      break;
    default:
      process.stderr.write(`octi plugin: unknown subcommand "${sub}"\n\n${HELP}`);
      process.exit(1);
  }
}

await main();
