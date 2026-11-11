#!/usr/bin/env tsx
/**
 * `octi plugin <subcommand>` (WS3).
 *
 *   octi plugin validate <dir> [--json]  Validate a plugin package (or a legacy plugin) against the contract.
 *   octi plugin convert <dir>    Convert a legacy plugin into a plugin package.
 *   octi plugin keygen <prefix> [--passphrase-file <path|->]  Make an Ed25519 signing key pair.
 *   octi plugin sign <dir> --key <file>  Sign a plugin package (octipus-plugin.sig).
 *   octi plugin sign-index <index.json> --key <file>  Sign a registry index (<index.json>.sig).
 *   octi plugin hash <dir> [--json]  The content hash install records.
 *   octi plugin pack <dir> --out <file.tar.gz> [--json]  A reproducible tarball of the package.
 *   octi plugin permissions <dir> [--json]  What the package asks for, from its manifest.
 *   octi plugin verify <dir> --pub <file.pub>  Check the package's signature.
 *   octi plugin verify-index <index.json> --pub <file.pub>...  Check a registry index's signature.
 *   octi plugin list             Installed packages (through the running backend).
 *   octi plugin approve <name> [--hash sha256:…]  Approve a package's changed content.
 *   octi plugin approve-in-process <name> [--hash sha256:…]  Approve an in-process plugin to run in the server process.
 *   octi plugin approve-contributions <name> [--hash sha256:…]  Approve what a package adds (commands, schedules, events, prompt, context).
 *   octi plugin approve-cli-tools <name> [--yes] [--revoke]  Let a package's model calls run on CLI lanes (model:cli-tools).
 *   octi plugin set <name> key=value...  Change a package's settings.
 *   octi plugin secret <name> <KEY> [--clear]  Set (from stdin or a hidden prompt) or remove a secret.
 *   octi plugin uninstall <name> [--yes]  Remove a package.
 *   octi plugin bundled          The first-party plugins shipped with Octipus.
 *   octi plugin install-bundled <name> [--upgrade]  Install one (disabled).
 *   octi plugin marketplace [query] [--category <c>]  What the marketplace and the registries offer.
 *   octi plugin updates          Installed packages with a newer version from the same source.
 *   octi plugin install|upgrade <name> [--version v] [--registry r] [--accept all|ids] [--enable] …  Install from the marketplace, with consent per item.
 *   octi plugin sign-keys <keys.json> --key <root.key>  Sign a marketplace keys file with a root key.
 *   octi plugin verify-keys <keys.json> --root-pub <file>...  Check a marketplace keys file.
 *   octi plugin unpack <tarball> --out <dir>      Unpack with the strict tar reader install uses.
 *
 * Delegated from bin/octi. The offline subcommands (validate, keygen, sign,
 * sign-index, sign-keys, verify-keys, hash, pack, unpack, permissions, verify,
 * verify-index) live in
 * ./plugin-offline.ts and need no server; they run the host's own code, so
 * authors, a marketplace's CI and the host run identical checks.
 */
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ConvertError, convertLegacyPlugin } from '@/plugins/convert';
import { PLUGIN_TOOL_EFFECTS, type PluginToolEffect } from '@/shared/plugin-package';
import { approveCliToolsCommand, approveCommand, approveContributionsCommand, approveInProcessCommand, bundledCommand, installBundledCommand, installCommand, listCommand, marketplaceCommand, type PluginApiIo, readAllText, readHiddenLine, secretCommandFromArgs, setCommand, uninstallCommand, updatesCommand } from './plugin-api';
import {
  hashCommand,
  keygenCommand,
  MAX_PASSPHRASE_BYTES,
  type OfflineIo,
  packCommand,
  permissionsCommand,
  signCommand,
  signIndexCommand,
  signKeysCommand,
  unpackCommand,
  validateCommand,
  verifyCommand,
  verifyIndexCommand,
  verifyKeysCommand,
} from './plugin-offline';

const HELP = `octi plugin — plugin tooling

Usage:
  octi plugin validate <dir> [--json]
                                Validate a plugin package (octipus-plugin.json) the way
                                an install checks it: manifest, tree, server files,
                                contributions. A legacy plugin (plugin.json) is checked
                                with the plugin SDK's kit. --json prints
                                {"ok","problems","warnings"}; exit 1 when not ok.
  octi plugin convert <legacy-dir> [--out <dir>] [--effect <tool>=<read|write|external>]... [--network <host>]... [--check-handlers]
                                Convert a legacy plugin (plugin.json; they load from
                                ~/.octipus/legacy-plugins/<name>, no longer from
                                <cwd>/extensions) into a plugin package
                                (octipus-plugin.json + MCP server). --out defaults to
                                <cwd>/<name>-package: run it outside the Octipus
                                checkout, or pass --out. Every tool
                                is "external" (always ask) unless --effect lowers it.
                                --check-handlers imports the plugin here to check every
                                tool has a handler: that runs its code with your rights.
  octi plugin keygen <out-prefix> [--passphrase-file <path|->] [--json]
                                Make an Ed25519 key pair: <out-prefix>.key (private,
                                0600, keep it secret) and <out-prefix>.pub (public, for
                                plugins.trustedPublishers). Never overwrites a file.
                                --passphrase-file encrypts the private key (PKCS#8,
                                AES-256-CBC) with the passphrase in that file, or on
                                stdin for "-" (one trailing newline dropped; empty
                                refused).
  octi plugin sign <dir> --key <private-key-file> [--passphrase-file <path|->] [--json]
                                Sign a plugin package: writes <dir>/octipus-plugin.sig
                                over its content hash. Sign last: any later change to
                                the files invalidates the signature. An encrypted key
                                takes its passphrase from --passphrase-file, else it is
                                asked at the terminal (no echo); with no terminal, sign
                                is refused.
  octi plugin sign-index <index.json> --key <private-key-file> [--passphrase-file <path|->] [--json]
                                Sign a registry index: writes <index.json>.sig over its
                                exact bytes. Publish both side by side; a registry
                                configured with "publisher" lists the index only when
                                the .sig verifies with a trusted key of that publisher.
                                Passphrases as for sign.
  octi plugin hash <dir> [--json]
                                The package's content hash, as install records it
                                (octipus-plugin.sig and marketplace.json left out).
                                Refuses what install refuses. --json prints
                                {"name","version","contentHash"}.
  octi plugin pack <dir> --out <file.tar.gz> [--json]
                                A reproducible tarball of the package under
                                <name>-<version>/: sorted entries, mtime 0, owner 0,
                                modes 0644/0755, fixed gzip; octipus-plugin.sig
                                included, marketplace.json left out. --json prints
                                {"file","sha256","contentHash","name","version"}.
  octi plugin permissions <dir> [--json]
                                What the package asks for, from its manifest alone:
                                host scopes, network hosts, tools and effects,
                                contributions, pages, model.trustedInput, maxProtection.
  octi plugin verify <dir> --pub <public-key-file> [--json]
                                Check <dir>/octipus-plugin.sig against the key and the
                                current content hash. Exit 0 when valid, 1 otherwise;
                                --json prints {"valid","keyId","contentHash","error"?}.
  octi plugin verify-index <index.json> --pub <public-key-file>... [--json]
                                Check <index.json>.sig over the exact index bytes;
                                passes when any one --pub verifies it, and names it.
                                --json prints {"valid","keyId","pub","sha256","error"?}.
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
  octi plugin approve-cli-tools <name> [--yes] [--revoke]
                                Approve model:cli-tools for a package that declares
                                model.trustedInput: its model calls may then run on a
                                CLI agent with its own tools (shell, files) as the
                                server user. Only for prompts that never carry outside
                                data. Asks at a terminal; elsewhere refused without
                                --yes. --revoke takes it back; an upgrade clears it.
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
  octi plugin marketplace [query] [--category <c>]
                                What the Octipus marketplace and plugins.registries
                                offer, what each asks for, installed and update state.
  octi plugin updates           Installed packages with a newer version from the same
                                source, with what changes in what they ask for.
  octi plugin install <name> [--version <v>] [--registry <name>]
                         [--accept all|<id,id,…>] [--enable]
                         [--allow-source-change] [--allow-signer-change]
                         [--allow-downgrade] [--allow-incompatible] [--keep-store-data]
  octi plugin upgrade <name> [the same options]
                                Install (or upgrade) from the marketplace or a registry
                                by name, the newest compatible version. Prints what it
                                declares; each item not unchanged from the installed
                                version is agreed to, y/n at a terminal or with
                                --accept (refused otherwise). Lands disabled unless
                                --enable. --allow-* agree to that change item. An
                                upgrade to another signer or source deletes the
                                package's stored data unless --keep-store-data.
  octi plugin sign-keys <keys.json> --key <root.key> [--root-pub <file>...]
                         [--passphrase-file <path|->] [--json]
                                Sign the marketplace's keys file with a ROOT key
                                (keys.json.sig), after checking it as a host reads it:
                                the schema, no root (this one, any --root-pub) among
                                the signing keys, not expired. Offline.
  octi plugin verify-keys <keys.json> --root-pub <file>... [--json]
                                Check <keys.json>.sig by a root (first --root-pub is
                                root, second rootBackup), the schema, the root
                                revocation rule and expires. --json prints {"valid",
                                "keyId","version","endorsed","revoked","error"?}.
  octi plugin unpack <tarball> --out <dir> [--json]
                                Unpack with the strict tar reader install uses into a
                                new or empty <dir>. --json prints {"out","root",
                                "sha256","name","version"}.

validate, keygen, sign, sign-index, sign-keys, verify-keys, hash, pack, unpack,
permissions, verify and verify-index work offline: they need no running server. With --json they print one JSON
document on stdout and every diagnostic on stderr; every subcommand exits non-zero on error.

list, approve, approve-in-process, approve-contributions, approve-cli-tools, set, secret, uninstall, bundled, install-bundled, marketplace, updates, install and upgrade call the running backend (http://localhost:$API_PORT, 3005 by
default) with the admin API token in OCTIPUS_API_TOKEN (Settings → API Tokens).
`;

/**
 * Exit once stdout and stderr are flushed: on a pipe they may be written
 * asynchronously (macOS), and `process.exit` would cut off the JSON a
 * script is reading.
 */
async function exitFlushed(code: number): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map((s) => new Promise<void>((done) => s.write('', () => done()))));
  process.exit(code);
}

function offlineIo(): OfflineIo {
  return {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    stdin: process.stdin,
    interactive: process.stdin.isTTY === true,
    readHidden: (prompt) => readHiddenLine(process.stdin, (t) => process.stderr.write(t), prompt, MAX_PASSPHRASE_BYTES),
  };
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
    case 'validate':
      await exitFlushed(await validateCommand(offlineIo(), rest));
      break;
    case 'convert':
      await runConvert(rest);
      break;
    case 'keygen':
      await exitFlushed(await keygenCommand(offlineIo(), rest));
      break;
    case 'sign':
      await exitFlushed(await signCommand(offlineIo(), rest));
      break;
    case 'sign-index':
      await exitFlushed(await signIndexCommand(offlineIo(), rest));
      break;
    case 'hash':
      await exitFlushed(await hashCommand(offlineIo(), rest));
      break;
    case 'pack':
      await exitFlushed(await packCommand(offlineIo(), rest));
      break;
    case 'permissions':
      await exitFlushed(await permissionsCommand(offlineIo(), rest));
      break;
    case 'verify':
      await exitFlushed(await verifyCommand(offlineIo(), rest));
      break;
    case 'verify-index':
      await exitFlushed(await verifyIndexCommand(offlineIo(), rest));
      break;
    case 'list':
      process.exit(await listCommand(apiIo()));
      break;
    case 'approve':
    case 'approve-in-process':
    case 'approve-contributions':
      await runApprove(sub, rest);
      break;
    case 'approve-cli-tools': {
      let parsed: { values: { yes?: boolean; revoke?: boolean }; positionals: string[] };
      try {
        parsed = parseArgs({ args: rest, allowPositionals: true, options: { yes: { type: 'boolean' }, revoke: { type: 'boolean' } } });
      } catch (err) {
        usage(sub, (err as Error).message);
      }
      if (parsed.positionals.length !== 1) usage(sub, 'expected <name> [--yes] [--revoke]');
      process.exit(await approveCliToolsCommand(apiIo(), parsed.positionals[0], { yes: parsed.values.yes === true, revoke: parsed.values.revoke === true }));
      break;
    }
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
    case 'marketplace': {
      let parsed: { values: { category?: string }; positionals: string[] };
      try {
        parsed = parseArgs({ args: rest, allowPositionals: true, options: { category: { type: 'string' } } });
      } catch (err) {
        usage(sub, (err as Error).message);
      }
      process.exit(await marketplaceCommand(apiIo(), parsed.positionals.join(' ') || undefined, parsed.values.category));
      break;
    }
    case 'updates':
      process.exit(await updatesCommand(apiIo()));
      break;
    case 'install':
    case 'upgrade': {
      let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
      try {
        parsed = parseArgs({
          args: rest, allowPositionals: true,
          options: {
            version: { type: 'string' }, registry: { type: 'string' }, upgrade: { type: 'boolean' },
            'allow-source-change': { type: 'boolean' }, 'allow-signer-change': { type: 'boolean' },
            'allow-downgrade': { type: 'boolean' }, 'allow-incompatible': { type: 'boolean' }, 'keep-store-data': { type: 'boolean' },
            accept: { type: 'string' }, enable: { type: 'boolean' },
          },
        });
      } catch (err) {
        usage(sub, (err as Error).message);
      }
      if (parsed.positionals.length !== 1) usage(sub, 'expected <name> [--version <v>] [--registry <name>] [--upgrade]');
      const v = parsed.values;
      process.exit(await installCommand(apiIo(), parsed.positionals[0], {
        version: v.version as string | undefined, registry: v.registry as string | undefined, upgrade: sub === 'upgrade' || v.upgrade === true,
        accept: v.accept as string | undefined, enable: v.enable === true,
        allowSourceChange: v['allow-source-change'] === true, allowSignerChange: v['allow-signer-change'] === true,
        allowDowngrade: v['allow-downgrade'] === true, allowIncompatible: v['allow-incompatible'] === true,
        keepStoreData: v['keep-store-data'] === true,
      }));
      break;
    }
    case 'sign-keys':
      await exitFlushed(await signKeysCommand(offlineIo(), rest));
      break;
    case 'verify-keys':
      await exitFlushed(await verifyKeysCommand(offlineIo(), rest));
      break;
    case 'unpack':
      await exitFlushed(await unpackCommand(offlineIo(), rest));
      break;
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
