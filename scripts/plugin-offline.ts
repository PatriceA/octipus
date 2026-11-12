/**
 * The offline `octi plugin` subcommands (docs/PLUGIN-PACKAGES.md#packing-and-publishing):
 * keys, signing, hashing, packing, permissions, verification and validation
 * of a plugin package, with no running server. A marketplace's CI and its
 * publishing machine call these, so the content hash, the tarball format, the
 * permissions summary and the signatures have exactly one implementation.
 *
 * Each command takes its arguments and an `OfflineIo`, and resolves to the
 * exit code: 0 done (for `verify`, valid), 1 refused or invalid, 2 a usage
 * error. With `--json`, stdout carries one JSON document and nothing else;
 * every diagnostic goes to stderr.
 */
import { createHash, createPublicKey } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { validatePlugin } from '@octipus/plugin-sdk/testing';
import { validatePluginDirectory } from '@/plugins/packages/authoring/validate';
import { hashPackageContent } from '@/plugins/packages/integrity';
import { ManifestError, parseManifest } from '@/plugins/packages/manifest';
import { KeysFileError, keysFileExpired, parseKeysFile, rootRevocationProblem, type RootKeyRef } from '@/plugins/packages/marketplace-keys-format';
import { packPackage } from '@/plugins/packages/pack';
import { packagePermissions } from '@/plugins/packages/permissions';
import {
  generateSigningKey,
  isEncryptedPrivateKey,
  keyFingerprint,
  parsePublicKey,
  readPrivateKey,
  readSignatureFile,
  REGISTRY_INDEX_SIGNATURE_SUFFIX,
  SignatureError,
  signPackage,
  signMarketplaceKeysFile,
  signRegistryIndexFile,
  trustedKeys,
  verifyMarketplaceKeys,
  verifyRegistryIndex,
  verifySignature,
} from '@/plugins/packages/signature';
import { extractTarGz, packageRootIn, TarError } from '@/plugins/packages/tar';
import { checkPackageTree, PackageTreeError } from '@/plugins/packages/tree';
import { PLUGIN_MANIFEST_FILE, type PluginManifest } from '@/shared/plugin-package';

/** What the offline commands need of the process: output, stdin, and a hidden prompt at a terminal. */
export interface OfflineIo {
  out(text: string): void;
  err(text: string): void;
  /** stdin, for `--passphrase-file -`. */
  stdin: AsyncIterable<string | Buffer>;
  /** Whether stdin is a terminal a passphrase can be asked at. */
  interactive: boolean;
  /** One line typed at the terminal without echo. */
  readHidden(prompt: string): Promise<string>;
}

/** The longest passphrase read (bytes); a longer file is not a passphrase. */
export const MAX_PASSPHRASE_BYTES = 4096;

/** A refusal with its message: exit 1, the message on stderr (and in `--json` where the shape has an `error`). */
class Refusal extends Error {
  constructor(message: string, readonly problems: string[] = [message]) {
    super(message);
    this.name = 'Refusal';
  }
}

class UsageError extends Error {}

function json(io: OfflineIo, value: unknown): void {
  io.out(`${JSON.stringify(value)}\n`);
}

function parse<T extends Record<string, { type: 'string' | 'boolean'; multiple?: boolean; short?: string }>>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, strict: true, options });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

/** The usage error of a subcommand: exit 2. */
function usage(io: OfflineIo, sub: string, message: string): number {
  io.err(`octi plugin ${sub}: ${message}\nRun "octi plugin help" for the usage of every subcommand.\n`);
  return 2;
}

/** Turn what a command threw into its exit code: usage 2, a known refusal 1 (its problems on stderr), else rethrow. */
function failure(io: OfflineIo, sub: string, err: unknown, what: string): number {
  if (err instanceof UsageError) return usage(io, sub, err.message);
  const problems = knownProblems(err);
  if (problems === null) throw err;
  for (const p of problems) io.err(`  ✗ ${p}\n`);
  io.err(`\n❌ ${what}\n`);
  return 1;
}

/** The problems of an error a command expects (a bad manifest, tree, key or file), or null for a bug. */
function knownProblems(err: unknown): string[] | null {
  if (err instanceof ManifestError) return err.problems.map((p) => `${PLUGIN_MANIFEST_FILE}: ${p}`);
  if (err instanceof Refusal) return err.problems;
  if (err instanceof SignatureError || err instanceof PackageTreeError || err instanceof KeysFileError || err instanceof TarError) return [err.message];
  if (err instanceof SyntaxError) return [`not valid JSON: ${err.message}`];
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return [(err as Error).message];
  return null;
}

function errorMessage(err: unknown): string {
  const problems = knownProblems(err);
  if (problems === null) throw err;
  return problems.join('; ');
}

/** Read and parse a package's manifest with the parser install uses. */
async function readPackageManifest(dir: string): Promise<PluginManifest> {
  let raw: string;
  try {
    raw = await readFile(join(dir, PLUGIN_MANIFEST_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Refusal(`No ${PLUGIN_MANIFEST_FILE} in ${dir}`);
    throw err;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Refusal(`${PLUGIN_MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  return parseManifest(value);
}

/** All of a stream, refusing more than `max` bytes. */
async function readStream(input: AsyncIterable<string | Buffer>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    total += bytes.length;
    if (total > max) throw new Refusal(`the passphrase is longer than ${max} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/**
 * The passphrase in a file, or on stdin for `-`: its text without the one
 * trailing newline (`\n` or `\r\n`). An empty passphrase is refused. The
 * messages never carry the passphrase.
 */
export async function readPassphraseFile(io: OfflineIo, source: string): Promise<string> {
  let bytes: Buffer;
  if (source === '-') {
    bytes = await readStream(io.stdin, MAX_PASSPHRASE_BYTES);
  } else {
    const info = await lstat(resolve(source)).catch(() => null);
    if (!info) throw new Refusal(`cannot read the passphrase file ${source}`);
    if (!info.isFile()) throw new Refusal(`the passphrase file ${source} is not a regular file`);
    if (info.size > MAX_PASSPHRASE_BYTES) throw new Refusal(`the passphrase file ${source} is longer than ${MAX_PASSPHRASE_BYTES} bytes`);
    bytes = await readFile(resolve(source));
  }
  const text = bytes.toString('utf8').replace(/\r?\n$/, '');
  if (text === '') throw new Refusal(`the passphrase ${source === '-' ? 'on stdin' : `in ${source}`} is empty; an empty passphrase is refused`);
  return text;
}

/**
 * The signing key in `keyFile`, decrypted when it is encrypted: with the
 * passphrase from `--passphrase-file`, else asked at the terminal without
 * echo, else refused (no terminal to ask at).
 */
async function loadSigningKey(io: OfflineIo, keyFile: string, passphraseFile: string | undefined) {
  const pem = await readFile(resolve(keyFile), 'utf8');
  if (!isEncryptedPrivateKey(pem)) {
    if (passphraseFile !== undefined) io.err(`  ⚠ ${keyFile} is not encrypted; --passphrase-file is not needed\n`);
    return readPrivateKey(pem);
  }
  let passphrase: string;
  if (passphraseFile !== undefined) {
    passphrase = await readPassphraseFile(io, passphraseFile);
  } else if (io.interactive) {
    try {
      passphrase = await io.readHidden(`Passphrase for ${keyFile}: `);
    } catch {
      throw new Refusal('no passphrase given (cancelled)');
    }
    if (passphrase === '') throw new Refusal('no passphrase given; an empty passphrase is refused');
  } else {
    throw new Refusal(`${keyFile} is encrypted and there is no terminal to ask for its passphrase; pass --passphrase-file <path|->`);
  }
  return readPrivateKey(pem, passphrase);
}

/** `octi plugin keygen <prefix> [--passphrase-file <path|->] [--json]` */
export async function keygenCommand(io: OfflineIo, argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parse(argv, { 'passphrase-file': { type: 'string' }, json: { type: 'boolean' } });
    if (positionals.length !== 1) throw new UsageError('expected one <out-prefix>');
    const prefix = resolve(positionals[0]);
    const passphraseFile = values['passphrase-file'] as string | undefined;
    const passphrase = passphraseFile === undefined ? undefined : await readPassphraseFile(io, passphraseFile);
    if (passphrase === undefined) {
      // Guidance, not a refusal: a CI key may be kept in a secret store instead.
      io.err('⚠ WARNING: the private key is written UNENCRYPTED. Anyone who reads the .key file can sign as you.\n'
        + '  Pass --passphrase-file <path|-> to encrypt it; a marketplace ROOT key must always be encrypted and kept offline.\n');
    }
    const { privateKeyPem, publicKeyPem, keyId } = generateSigningKey(passphrase);
    // 'wx': never overwrite a key someone may already have published.
    await writeFile(`${prefix}.key`, privateKeyPem, { flag: 'wx', mode: 0o600 });
    await writeFile(`${prefix}.pub`, publicKeyPem, { flag: 'wx', mode: 0o644 });
    if (values.json) {
      json(io, { key: `${prefix}.key`, pub: `${prefix}.pub`, keyId, encrypted: passphrase !== undefined });
      return 0;
    }
    io.out(`✅ Wrote ${prefix}.key (private${passphrase !== undefined ? ', encrypted with the passphrase' : ''}: keep it secret) and ${prefix}.pub\n`);
    io.out(`   key id: ${keyId}\n\n`);
    io.out('Trust it on a host with plugins.trustedPublishers:\n');
    io.out(`${JSON.stringify([{ name: '<publisher name>', publicKey: publicKeyPem.trim() }], null, 2)}\n`);
    return 0;
  } catch (err) {
    return failure(io, 'keygen', err, 'No key was written.');
  }
}

/** `octi plugin sign <dir> --key <file> [--passphrase-file <path|->] [--json]` */
export async function signCommand(io: OfflineIo, argv: string[]): Promise<number> {
  let dir = '';
  try {
    const { values, positionals } = parse(argv, { key: { type: 'string', short: 'k' }, 'passphrase-file': { type: 'string' }, json: { type: 'boolean' } });
    if (positionals.length !== 1 || !values.key) throw new UsageError('expected <dir> --key <private-key-file> [--passphrase-file <path|->]');
    dir = resolve(positionals[0]);
    const key = await loadSigningKey(io, values.key as string, values['passphrase-file'] as string | undefined);
    const { contentHash, keyId, file } = await signPackage(dir, key);
    if (values.json) json(io, { file, contentHash, keyId });
    else io.out(`✅ Signed ${dir}\n   content hash: ${contentHash}\n   key id: ${keyId}\n   wrote ${file}\n`);
    return 0;
  } catch (err) {
    return failure(io, 'sign', err, `${dir || 'The package'} was not signed.`);
  }
}

/** `octi plugin sign-index <index.json> --key <file> [--passphrase-file <path|->] [--json]` */
export async function signIndexCommand(io: OfflineIo, argv: string[]): Promise<number> {
  let file = '';
  try {
    const { values, positionals } = parse(argv, { key: { type: 'string', short: 'k' }, 'passphrase-file': { type: 'string' }, json: { type: 'boolean' } });
    if (positionals.length !== 1 || !values.key) throw new UsageError('expected <index.json> --key <private-key-file> [--passphrase-file <path|->]');
    file = resolve(positionals[0]);
    const key = await loadSigningKey(io, values.key as string, values['passphrase-file'] as string | undefined);
    const { sigFile, keyId, sha256 } = await signRegistryIndexFile(file, key);
    if (values.json) {
      json(io, { sigFile, sha256, keyId });
      return 0;
    }
    io.out(`✅ Signed ${file}\n   index hash: ${sha256}\n   key id: ${keyId}\n   wrote ${sigFile}\n`);
    io.out('   Publish both files unchanged: any change to the index bytes invalidates the signature.\n');
    return 0;
  } catch (err) {
    return failure(io, 'sign-index', err, `${file || 'The index'} was not signed.`);
  }
}

/**
 * `octi plugin sign-keys <keys.json> --key <root.key> [--passphrase-file <path|->] [--json]`:
 * sign the marketplace's keys file (its signing keys and revocations) with a
 * ROOT key, writing `keys.json.sig` (docs/PLUGIN-PACKAGES.md#marketplace-keys).
 * Root keys sign nothing else.
 */
export async function signKeysCommand(io: OfflineIo, argv: string[]): Promise<number> {
  let file = '';
  try {
    const { values, positionals } = parse(argv, { key: { type: 'string', short: 'k' }, 'passphrase-file': { type: 'string' }, 'root-pub': { type: 'string', multiple: true }, json: { type: 'boolean' } });
    if (positionals.length !== 1 || !values.key) throw new UsageError('expected <keys.json> --key <root-private-key-file> [--root-pub <file>...] [--passphrase-file <path|->]');
    file = resolve(positionals[0]);
    const key = await loadSigningKey(io, values.key as string, values['passphrase-file'] as string | undefined);
    // Checked exactly as a host reads it before anything is signed: the schema
    // (a whole version, known fields only), no root among the signing keys
    // (this one, and any --root-pub), and not already expired.
    const signer = keyFingerprint(createPublicKey(key));
    const otherRoots = await readPublicKeys((values['root-pub'] as string[] | undefined) ?? []);
    const parsed = parseKeysFile(await readFile(file), [{ keyId: signer }, ...otherRoots.map((r) => ({ keyId: r.keyId }))]);
    const expired = keysFileExpired(parsed);
    if (expired) throw new Refusal(expired);
    const { sigFile, keyId, sha256 } = await signMarketplaceKeysFile(file, key);
    if (values.json) {
      json(io, { sigFile, sha256, keyId });
      return 0;
    }
    io.out(`✅ Signed ${file}\n   keys file hash: ${sha256}\n   root key id: ${keyId}\n   wrote ${sigFile}\n`);
    io.out('   Publish both files unchanged, at <marketplace origin>/keys.json and keys.json.sig.\n');
    return 0;
  } catch (err) {
    return failure(io, 'sign-keys', err, `${file || 'The keys file'} was not signed.`);
  }
}

/** `octi plugin hash <dir> [--json]`: the content hash install records (the listing file left out). */
export async function hashCommand(io: OfflineIo, argv: string[]): Promise<number> {
  let dir = '';
  try {
    const { values, positionals } = parse(argv, { json: { type: 'boolean' } });
    if (positionals.length !== 1) throw new UsageError('expected <dir> [--json]');
    dir = resolve(positionals[0]);
    await checkPackageTree(dir);
    const manifest = await readPackageManifest(dir);
    const contentHash = await hashPackageContent(dir, manifest, { source: true });
    if (values.json) json(io, { name: manifest.name, version: manifest.version, contentHash });
    else io.out(`${contentHash}\n`);
    return 0;
  } catch (err) {
    return failure(io, 'hash', err, `${dir || 'The package'} cannot be hashed.`);
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** `octi plugin pack <dir> --out <file.tar.gz> [--json]`: the reproducible tarball. */
export async function packCommand(io: OfflineIo, argv: string[]): Promise<number> {
  let dir = '';
  try {
    const { values, positionals } = parse(argv, { out: { type: 'string', short: 'o' }, json: { type: 'boolean' } });
    if (positionals.length !== 1 || !values.out) throw new UsageError('expected <dir> --out <file.tar.gz> [--json]');
    dir = resolve(positionals[0]);
    const out = resolve(values.out as string);
    if (inside(dir, out)) throw new Refusal(`--out ${out} is inside the package; write the tarball outside it`);
    const packed = await packPackage(dir);
    await writeFile(out, packed.tarball, { mode: 0o644 });
    if (values.json) {
      json(io, { file: out, sha256: packed.sha256, contentHash: packed.contentHash, name: packed.manifest.name, version: packed.manifest.version });
    } else {
      io.out(`✅ Packed ${packed.manifest.name} ${packed.manifest.version} into ${out}\n   sha256: ${packed.sha256}\n   content hash: ${packed.contentHash}\n`);
    }
    return 0;
  } catch (err) {
    return failure(io, 'pack', err, `${dir || 'The package'} was not packed.`);
  }
}

/** `octi plugin permissions <dir> [--json]`: what the package asks for, from its manifest alone. */
export async function permissionsCommand(io: OfflineIo, argv: string[]): Promise<number> {
  let dir = '';
  try {
    const { values, positionals } = parse(argv, { json: { type: 'boolean' } });
    if (positionals.length !== 1) throw new UsageError('expected <dir> [--json]');
    dir = resolve(positionals[0]);
    const p = await packagePermissions(await readPackageManifest(dir), dir);
    if (values.json) {
      json(io, p);
      return 0;
    }
    const list = (xs: readonly string[]) => (xs.length ? xs.join(', ') : 'none');
    io.out(`${p.name} ${p.version} (apiVersion ${p.apiVersion}, runtime ${p.runtime})\n`);
    io.out(`  host scopes:   ${list(p.host)}\n  network hosts: ${list(p.network)}\n`);
    io.out(`  tools:         ${p.tools.length ? p.tools.map((t) => `${t.name} (${t.effect})`).join(', ') : 'none'}\n`);
    io.out(`  effects:       read ${p.effects.read}, write ${p.effects.write}, external ${p.effects.external}\n`);
    const c = p.contributions;
    const roles = (r: readonly string[] | undefined) => (r ? `roles ${r.join(', ')}` : 'every role');
    io.out(`  commands:      ${list(c.commands.map((x) => `/${x.name} → ${x.tool}`))}\n`);
    io.out(`  schedules:     ${list(c.schedules.map((x) => `${x.id} (${x.cron} UTC) → ${x.tool}${x.input !== undefined ? ` ${JSON.stringify(x.input)}` : ''}`))}\n`);
    io.out(`  events:        ${list(c.events.map((x) => `${x.on} → ${x.tool}`))}\n`);
    io.out(`  prompt:        ${c.prompt ? `${c.prompt.file} (${roles(c.prompt.roles)}), sha256 ${c.prompt.sha256 ?? 'unreadable'}` : 'none'}\n`);
    io.out(`  context:       ${c.context ? `${c.context.tool} (${roles(c.context.roles)})` : 'none'}\n`);
    io.out(`  pages:         ${list(p.pages.map((x) => `/${x.path} "${x.title}" → ${x.entry}`))}${p.ui ? `; ${p.ui.dir}/ sha256 ${p.ui.sha256 ?? 'unreadable'}` : ''}\n`);
    io.out(`  trustedInput: ${p.trustedInput ? 'yes' : 'no'}; maxProtection: ${p.maxProtection}\n`);
    return 0;
  } catch (err) {
    return failure(io, 'permissions', err, `${dir || 'The package'}: no permissions computed.`);
  }
}

/** Public keys given with `--pub`: each file's key, its id and its path. */
async function readPublicKeys(files: readonly string[]): Promise<Array<{ path: string; publicKey: string; keyId: string }>> {
  const keys: Array<{ path: string; publicKey: string; keyId: string }> = [];
  for (const path of files) {
    const publicKey = await readFile(resolve(path), 'utf8');
    let keyId: string;
    try {
      keyId = keyFingerprint(parsePublicKey(publicKey));
    } catch (err) {
      throw new Refusal(`${path}: ${(err as Error).message}`);
    }
    keys.push({ path, publicKey, keyId });
  }
  return keys;
}

/** `octi plugin verify <dir> --pub <file.pub>... [--json]`: the package's signature against its content and the given key(s). */
export async function verifyCommand(io: OfflineIo, argv: string[]): Promise<number> {
  let values: { pub?: string[]; json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parse(argv, { pub: { type: 'string', multiple: true }, json: { type: 'boolean' } }) as { values: typeof values; positionals: string[] });
    if (positionals.length !== 1 || !values.pub?.length) throw new UsageError('expected <dir> --pub <public-key-file> [--json]');
  } catch (err) {
    return failure(io, 'verify', err, '');
  }
  const dir = resolve(positionals[0]);
  let keyId: string | null = null;
  let contentHash: string | null = null;
  const report = (valid: boolean, error?: string): number => {
    if (values.json) json(io, error === undefined ? { valid, keyId, contentHash } : { valid, keyId, contentHash, error });
    if (error !== undefined) io.err(`  ✗ ${error}\n\n❌ The signature of ${dir} does not verify.\n`);
    else if (!values.json) io.out(`✅ ${dir} is signed by ${keyId}\n   content hash: ${contentHash}\n`);
    return valid ? 0 : 1;
  };
  try {
    await checkPackageTree(dir);
    const manifest = await readPackageManifest(dir);
    contentHash = await hashPackageContent(dir, manifest, { source: true });
    const onDisk = await readSignatureFile(dir);
    if (onDisk === null) return report(false, `${dir} is not signed (no octipus-plugin.sig)`);
    keyId = onDisk.file.keyId;
    const keys = await readPublicKeys(values.pub);
    const check = verifySignature(contentHash, onDisk.file, trustedKeys(keys.map((k) => ({ name: k.path, publicKey: k.publicKey }))));
    switch (check.status) {
      case 'valid': return report(true);
      case 'unknown_key': return report(false, `signed by ${check.keyId}, which is not the key in ${values.pub.join(', ')}`);
      case 'invalid': return report(false, check.reason);
      case 'unsigned': return report(false, `${dir} is not signed`);
      default: return report(false, check.detail);
    }
  } catch (err) {
    return report(false, errorMessage(err));
  }
}

/** `octi plugin verify-index <index.json> --pub <file.pub>... [--json]`: `<index.json>.sig` over the exact bytes, by any one of the keys. */
export async function verifyIndexCommand(io: OfflineIo, argv: string[]): Promise<number> {
  let values: { pub?: string[]; json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parse(argv, { pub: { type: 'string', multiple: true }, json: { type: 'boolean' } }) as { values: typeof values; positionals: string[] });
    if (positionals.length !== 1 || !values.pub?.length) throw new UsageError('expected <index.json> --pub <public-key-file>... [--json]');
  } catch (err) {
    return failure(io, 'verify-index', err, '');
  }
  const file = resolve(positionals[0]);
  const sigFile = `${file}${REGISTRY_INDEX_SIGNATURE_SUFFIX}`;
  let keyId: string | null = null;
  let sha256: string | null = null;
  let pub: string | null = null;
  const report = (valid: boolean, error?: string): number => {
    const body = { valid, keyId, pub, sha256 };
    if (values.json) json(io, error === undefined ? body : { ...body, error });
    if (error !== undefined) io.err(`  ✗ ${error}\n\n❌ ${sigFile} does not verify.\n`);
    else if (!values.json) io.out(`✅ ${file} is signed by ${keyId} (${pub})\n   index hash: ${sha256}\n`);
    return valid ? 0 : 1;
  };
  try {
    const bytes = await readFile(file);
    sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    let sigText: string;
    try {
      sigText = await readFile(sigFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return report(false, `${file} is not signed (no ${sigFile})`);
      throw err;
    }
    const keys = await readPublicKeys(values.pub);
    const publisher = 'verify-index';
    const check = verifyRegistryIndex(bytes, sigText, publisher, keys.map((k) => ({ name: publisher, publicKey: k.publicKey })));
    if ('keyId' in check) keyId = check.keyId;
    switch (check.status) {
      case 'valid':
        pub = keys.find((k) => k.keyId === check.keyId)?.path ?? null;
        return report(true);
      case 'unknown_key': return report(false, `signed by ${check.keyId}, which is none of the keys in ${values.pub.join(', ')}`);
      case 'invalid': return report(false, check.reason);
      case 'unsigned': return report(false, `${file} is not signed`);
      default: return report(false, check.detail);
    }
  } catch (err) {
    return report(false, errorMessage(err));
  }
}

/**
 * `octi plugin verify-keys <keys.json> --root-pub <file>... [--json]`: the
 * marketplace keys file as a host checks it: `<keys.json>.sig` by one of the
 * roots (the first --root-pub is `root`, the second `rootBackup`), its schema,
 * no root among its signing keys, the root revocation rule, and `expires`.
 * --json prints `{ valid, keyId, version, endorsed: [keyId], revoked: [keyId], error? }`
 * (`keyId`: the root that signed it). A host also accepts a revocation only
 * for a key some accepted keys.json endorsed; this command cannot know that history.
 */
export async function verifyKeysCommand(io: OfflineIo, argv: string[]): Promise<number> {
  let values: { 'root-pub'?: string[]; json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parse(argv, { 'root-pub': { type: 'string', multiple: true }, json: { type: 'boolean' } }) as { values: typeof values; positionals: string[] });
    if (positionals.length !== 1 || !values['root-pub']?.length) throw new UsageError('expected <keys.json> --root-pub <public-key-file>... [--json]');
    if (values['root-pub'].length > 2) throw new UsageError('at most two --root-pub: root, then rootBackup');
  } catch (err) {
    return failure(io, 'verify-keys', err, '');
  }
  const file = resolve(positionals[0]);
  const sigFile = `${file}${REGISTRY_INDEX_SIGNATURE_SUFFIX}`;
  let keyId: string | null = null;
  let version: number | null = null;
  let endorsed: string[] = [];
  let revoked: string[] = [];
  const report = (valid: boolean, error?: string): number => {
    const body = { valid, keyId, version, endorsed, revoked };
    if (values.json) json(io, error === undefined ? body : { ...body, error });
    if (error !== undefined) io.err(`  ✗ ${error}\n\n❌ ${file} does not verify as a marketplace keys file.\n`);
    else if (!values.json) io.out(`✅ ${file} version ${version} is signed by the root ${keyId}\n   endorses: ${endorsed.join(', ') || '(none)'}\n   revokes: ${revoked.join(', ') || '(none)'}\n`);
    return valid ? 0 : 1;
  };
  try {
    const bytes = await readFile(file);
    let sigText: string;
    try {
      sigText = await readFile(sigFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return report(false, `${file} is not signed (no ${sigFile})`);
      throw err;
    }
    const keys = await readPublicKeys(values['root-pub'] as string[]);
    const roots: RootKeyRef[] = keys.map((k, i) => ({ role: i === 0 ? 'root' : 'rootBackup', keyId: k.keyId }));
    const check = verifyMarketplaceKeys(bytes, sigText, keys.map((k, i) => ({ name: roots[i].role, publicKey: k.publicKey })));
    if ('keyId' in check) keyId = check.keyId;
    if (check.status !== 'valid') {
      switch (check.status) {
        case 'unknown_key': return report(false, `signed by ${check.keyId}, which is none of the roots in ${(values['root-pub'] as string[]).join(', ')}`);
        case 'invalid': return report(false, check.reason);
        case 'unsigned': return report(false, `${file} is not signed`);
        default: return report(false, check.detail);
      }
    }
    const parsed = parseKeysFile(bytes, roots);
    version = parsed.version;
    endorsed = parsed.signingKeys.map((k) => k.keyId);
    revoked = parsed.revokedKeys.map((k) => k.keyId);
    const problem = rootRevocationProblem(check.keyId, roots, revoked) ?? keysFileExpired(parsed);
    if (problem) return report(false, problem);
    return report(true);
  } catch (err) {
    return report(false, errorMessage(err));
  }
}

/**
 * `octi plugin unpack <tarball> --out <dir> [--json]`: unpack a package
 * tarball with the strict tar reader an install uses (no links, no path out
 * of the target, no duplicate path, the size and file limits) into `<dir>`,
 * which must be missing or empty. --json prints
 * `{ out, root, sha256, name, version }` (`root`: the package directory in it).
 */
export async function unpackCommand(io: OfflineIo, argv: string[]): Promise<number> {
  let file = '';
  try {
    const { values, positionals } = parse(argv, { out: { type: 'string', short: 'o' }, json: { type: 'boolean' } });
    if (positionals.length !== 1 || !values.out) throw new UsageError('expected <tarball> --out <dir> [--json]');
    file = resolve(positionals[0]);
    const out = resolve(values.out as string);
    const tarball = await readFile(file);
    await mkdir(out, { recursive: true, mode: 0o700 });
    if ((await readdir(out)).length > 0) throw new Refusal(`--out ${out} is not empty; unpack into a new or empty directory`);
    await extractTarGz(tarball, out);
    const root = await packageRootIn(out);
    await checkPackageTree(root);
    const manifest = await readPackageManifest(root);
    const sha256 = `sha256:${createHash('sha256').update(tarball).digest('hex')}`;
    if (values.json) json(io, { out, root, sha256, name: manifest.name, version: manifest.version });
    else io.out(`✅ Unpacked ${manifest.name} ${manifest.version} into ${root}\n   sha256: ${sha256}\n`);
    return 0;
  } catch (err) {
    return failure(io, 'unpack', err, `${file || 'The tarball'} was not unpacked (what was written stays for inspection).`);
  }
}

/**
 * `octi plugin validate <dir> [--json]`: a plugin package (`octipus-plugin.json`)
 * with the checks of `plugin_validate`, the way an install would check it; a
 * legacy plugin (`plugin.json`) with the plugin SDK's validation kit.
 */
export async function validateCommand(io: OfflineIo, argv: string[]): Promise<number> {
  let values: { json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parse(argv, { json: { type: 'boolean' } }) as { values: typeof values; positionals: string[] });
    if (positionals.length !== 1) throw new UsageError('missing <dir>');
  } catch (err) {
    return failure(io, 'validate', err, '');
  }
  const dir = resolve(positionals[0]);
  const isPackage = (await lstat(join(dir, PLUGIN_MANIFEST_FILE)).catch(() => null)) !== null;
  const isLegacy = !isPackage && (await lstat(join(dir, 'plugin.json')).catch(() => null)) !== null;
  let ok: boolean;
  let problems: string[];
  let warnings: string[];
  let passed: string[] = [];
  if (isPackage || !isLegacy) {
    const report = await validatePluginDirectory(dir);
    ({ ok, problems, warnings } = report);
    if (report.ok && report.contentHash) passed = [`${report.name} ${report.version} fits the contract; content hash ${report.contentHash}`];
  } else {
    const report = await validatePlugin(dir);
    ({ ok, warnings, passed } = report);
    problems = report.errors;
  }
  if (values.json) {
    json(io, { ok, problems, warnings });
    for (const w of warnings) io.err(`  ⚠ ${w}\n`);
    for (const p of problems) io.err(`  ✗ ${p}\n`);
    return ok ? 0 : 1;
  }
  for (const p of passed) io.out(`  ✓ ${p}\n`);
  for (const w of warnings) io.out(`  ⚠ ${w}\n`);
  for (const p of problems) io.err(`  ✗ ${p}\n`);
  if (ok) {
    io.out(`\n✅ ${dir} is a valid ${isLegacy ? 'legacy plugin' : 'plugin package'}${warnings.length ? ' (with warnings)' : ''}.\n`);
    return 0;
  }
  io.err(`\n❌ ${dir} failed validation (${problems.length} problem(s)).\n`);
  return 1;
}
