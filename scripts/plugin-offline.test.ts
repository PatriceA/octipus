/**
 * The offline `octi plugin` subcommands (scripts/plugin-offline.ts): encrypted
 * keys and their passphrases, hash, pack, permissions, verify, verify-index
 * and validate, each with its exit code and, under --json, nothing but one
 * JSON document on stdout.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, test } from 'vitest';
import { extractTarGz, packageRootIn } from '@/plugins/packages/tar';
import { hashPackageContent } from '@/plugins/packages/integrity';
import { computePermissions, packagePermissions } from '@/plugins/packages/permissions';
import { parseManifest } from '@/plugins/packages/manifest';
import {
  hashCommand,
  keygenCommand,
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
import { makeTarGz } from '@/test-helpers/tar';

const ROOT = join(__dirname, '..');
const FIXTURE = join(ROOT, 'src/plugins/packages/fixtures/echo-plugin');
const dirs: string[] = [];
const temp = (prefix = 'octipus-offline-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface FakeIo extends OfflineIo {
  stdout: string;
  stderr: string;
  asked: string[];
}

function io(opts: { stdin?: string; interactive?: boolean; typed?: string } = {}): FakeIo {
  const fake: FakeIo = {
    stdout: '',
    stderr: '',
    asked: [],
    out: (t) => { fake.stdout += t; },
    err: (t) => { fake.stderr += t; },
    stdin: Readable.from(opts.stdin === undefined ? [] : [Buffer.from(opts.stdin)]),
    interactive: opts.interactive === true,
    readHidden: async (prompt) => {
      fake.asked.push(prompt);
      return opts.typed ?? '';
    },
  };
  return fake;
}

/** stdout as the one JSON document it must be. */
function jsonOut(fake: FakeIo): Record<string, unknown> {
  expect(fake.stdout.endsWith('\n')).toBe(true);
  expect(fake.stdout.trimEnd().split('\n')).toHaveLength(1);
  return JSON.parse(fake.stdout) as Record<string, unknown>;
}

/** A copy of the fixture package. */
function fixture(): string {
  const dir = temp('octipus-offline-pkg-');
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function passFile(text: string): string {
  const file = join(temp(), 'pass');
  writeFileSync(file, text);
  return file;
}

async function keys(passphrase?: string): Promise<{ key: string; pub: string }> {
  const prefix = join(temp('octipus-offline-keys-'), 'acme');
  const args = passphrase === undefined ? [prefix] : [prefix, '--passphrase-file', passFile(passphrase)];
  expect(await keygenCommand(io(), args)).toBe(0);
  return { key: `${prefix}.key`, pub: `${prefix}.pub` };
}

describe('encrypted keys', () => {
  test('keygen --passphrase-file writes encrypted PKCS#8 (0600); sign and verify round-trip with it', async () => {
    const PASS = 'correct horse battery staple';
    const { key, pub } = await keys(`${PASS}\n`);
    const pem = readFileSync(key, 'utf8');
    expect(pem.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')).toBe(true);
    expect(statSync(key).mode & 0o777).toBe(0o600);

    const dir = fixture();
    const signing = io();
    // The file's trailing newline is not part of the passphrase: the key was made from the same file.
    expect(await signCommand(signing, [dir, '--key', key, '--passphrase-file', passFile(`${PASS}\n`), '--json'])).toBe(0);
    const signed = jsonOut(signing);
    const verifying = io();
    expect(await verifyCommand(verifying, [dir, '--pub', pub, '--json'])).toBe(0);
    expect(jsonOut(verifying)).toEqual({ valid: true, keyId: signed.keyId, contentHash: signed.contentHash });
    // Without the newline it is the same passphrase.
    expect(await signCommand(io(), [dir, '--key', key, '--passphrase-file', passFile(PASS)])).toBe(0);
  });

  test('a wrong passphrase fails clearly, and the message carries neither the key nor the passphrase', async () => {
    const { key } = await keys('right one');
    const dir = fixture();
    const wrong = io();
    expect(await signCommand(wrong, [dir, '--key', key, '--passphrase-file', passFile('wrong one')])).toBe(1);
    expect(wrong.stderr).toMatch(/passphrase does not decrypt the private key/);
    const body = readFileSync(key, 'utf8').split('\n').slice(1, -2).join('');
    for (const secret of ['wrong one', 'right one', body, body.slice(0, 20)]) expect(wrong.stderr).not.toContain(secret);
    expect(existsSync(join(dir, 'octipus-plugin.sig'))).toBe(false);
  });

  test('- reads the passphrase from stdin, for keygen and for sign-index', async () => {
    const prefix = join(temp(), 'piped');
    expect(await keygenCommand(io({ stdin: 'from stdin\n' }), [prefix, '--passphrase-file', '-'])).toBe(0);
    expect(readFileSync(`${prefix}.key`, 'utf8')).toMatch(/^-----BEGIN ENCRYPTED PRIVATE KEY-----/);
    const index = join(temp(), 'index.json');
    writeFileSync(index, '{"packages":[]}');
    expect(await signIndexCommand(io({ stdin: 'from stdin' }), [index, '--key', `${prefix}.key`, '--passphrase-file', '-'])).toBe(0);
    expect(await verifyIndexCommand(io(), [index, '--pub', `${prefix}.pub`])).toBe(0);
    expect(await signIndexCommand(io({ stdin: 'not it\n' }), [index, '--key', `${prefix}.key`, '--passphrase-file', '-'])).toBe(1);
  });

  test('sign-keys signs a marketplace keys file with its own prefix: it verifies as a keys file, never as an index', async () => {
    const prefix = join(temp(), 'root');
    expect(await keygenCommand(io({ stdin: 'root pass' }), [prefix, '--passphrase-file', '-'])).toBe(0);
    const file = join(temp(), 'keys.json');
    writeFileSync(file, JSON.stringify({ schema: 1, version: 1, generatedAt: new Date().toISOString(), expires: new Date(Date.now() + 30 * 86_400_000).toISOString(), signingKeys: [], revokedKeys: [] }));
    expect(await signKeysCommand(io({ stdin: 'root pass' }), [file, '--key', `${prefix}.key`, '--passphrase-file', '-'])).toBe(0);
    const { verifyMarketplaceKeys } = await import('@/plugins/packages/signature');
    const pub = [{ name: 'root', publicKey: readFileSync(`${prefix}.pub`, 'utf8') }];
    expect(verifyMarketplaceKeys(readFileSync(file), readFileSync(`${file}.sig`, 'utf8'), pub).status).toBe('valid');
    expect(await verifyIndexCommand(io(), [file, '--pub', `${prefix}.pub`])).toBe(1);
  });

  test('an encrypted key without --passphrase-file is asked for at a terminal, and refused without one', async () => {
    const { key } = await keys('typed');
    const dir = fixture();
    const noTerminal = io();
    expect(await signCommand(noTerminal, [dir, '--key', key])).toBe(1);
    expect(noTerminal.stderr).toMatch(/encrypted and there is no terminal.*--passphrase-file/);
    const terminal = io({ interactive: true, typed: 'typed' });
    expect(await signCommand(terminal, [dir, '--key', key])).toBe(0);
    expect(terminal.asked).toEqual([`Passphrase for ${key}: `]);
    expect(await signCommand(io({ interactive: true, typed: '' }), [dir, '--key', key])).toBe(1);
  });

  test('an empty passphrase is refused and writes no key; unencrypted keys keep working', async () => {
    const prefix = join(temp(), 'empty');
    const refused = io();
    expect(await keygenCommand(refused, [prefix, '--passphrase-file', passFile('\n')])).toBe(1);
    expect(refused.stderr).toMatch(/empty passphrase is refused/);
    expect(existsSync(`${prefix}.key`)).toBe(false);
    expect(await keygenCommand(io({ stdin: '' }), [prefix, '--passphrase-file', '-'])).toBe(1);

    const { key, pub } = await keys();
    expect(readFileSync(key, 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const dir = fixture();
    expect(await signCommand(io(), [dir, '--key', key])).toBe(0);
    expect(await verifyCommand(io(), [dir, '--pub', pub])).toBe(0);
  });

  test('keygen never overwrites a key, and a missing argument is a usage error', async () => {
    const prefix = join(temp(), 'once');
    expect(await keygenCommand(io(), [prefix])).toBe(0);
    expect(await keygenCommand(io(), [prefix])).toBe(1);
    expect(await keygenCommand(io(), [])).toBe(2);
    expect(await signCommand(io(), [fixture()])).toBe(2);
  });
});

describe('hash', () => {
  test('prints the content hash install records; --json the name, version and hash', async () => {
    const dir = fixture();
    const fake = io();
    expect(await hashCommand(fake, [dir, '--json'])).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, 'octipus-plugin.json'), 'utf8'));
    expect(jsonOut(fake)).toEqual({ name: manifest.name, version: manifest.version, contentHash: await hashPackageContent(dir, manifest) });
    const plain = io();
    expect(await hashCommand(plain, [dir])).toBe(0);
    expect(plain.stdout).toBe(`${(jsonOut(fake)).contentHash}\n`);
  });

  test('marketplace.json does not change it; refuses a link like install', async () => {
    const dir = fixture();
    const before = io();
    await hashCommand(before, [dir, '--json']);
    writeFileSync(join(dir, 'marketplace.json'), '{"title":"x"}');
    const after = io();
    await hashCommand(after, [dir, '--json']);
    expect(jsonOut(after)).toEqual(jsonOut(before));

    symlinkSync('/etc/passwd', join(dir, 'passwd'));
    const linked = io();
    expect(await hashCommand(linked, [dir, '--json'])).toBe(1);
    expect(linked.stdout).toBe('');
    expect(linked.stderr).toMatch(/symbolic link/);
  });
});

describe('pack', () => {
  test('--json gives the file, the tarball sha256 and the content hash; packing twice gives the same bytes', async () => {
    const dir = fixture();
    writeFileSync(join(dir, 'marketplace.json'), '{"title":"x"}');
    const out = temp('octipus-offline-out-');
    const a = io();
    expect(await packCommand(a, [dir, '--out', join(out, 'a.tar.gz'), '--json'])).toBe(0);
    const first = jsonOut(a);
    const b = io();
    expect(await packCommand(b, [dir, '--out', join(out, 'b.tar.gz'), '--json'])).toBe(0);
    const second = jsonOut(b);
    const bytes = readFileSync(join(out, 'a.tar.gz'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(first.sha256);
    expect(second.sha256).toBe(first.sha256);
    expect(readFileSync(join(out, 'b.tar.gz')).equals(bytes)).toBe(true);
    expect(Object.keys(first)).toEqual(['file', 'sha256', 'contentHash', 'name', 'version']);
    expect(first.file).toBe(join(out, 'a.tar.gz'));

    // pack → the install reader → hashPackageContent equals `hash`.
    const hashed = io();
    await hashCommand(hashed, [dir, '--json']);
    expect(first.contentHash).toBe(jsonOut(hashed).contentHash);
    const unpacked = temp('octipus-offline-unpacked-');
    await extractTarGz(bytes, unpacked);
    const root = await packageRootIn(unpacked);
    expect(existsSync(join(root, 'marketplace.json'))).toBe(false);
    expect(await hashPackageContent(root, { name: String(first.name), version: String(first.version) })).toBe(first.contentHash);
  });

  test('refuses --out inside the package, and a missing --out is a usage error', async () => {
    const dir = fixture();
    const inside = io();
    expect(await packCommand(inside, [dir, '--out', join(dir, 'self.tar.gz'), '--json'])).toBe(1);
    expect(inside.stdout).toBe('');
    expect(existsSync(join(dir, 'self.tar.gz'))).toBe(false);
    expect(await packCommand(io(), [dir])).toBe(2);
  });

  test('a signed package packs with its signature, and verifies after unpacking', async () => {
    const { key, pub } = await keys();
    const dir = fixture();
    expect(await signCommand(io(), [dir, '--key', key])).toBe(0);
    const out = join(temp(), 'signed.tar.gz');
    expect(await packCommand(io(), [dir, '--out', out])).toBe(0);
    const unpacked = temp();
    await extractTarGz(readFileSync(out), unpacked);
    expect(await verifyCommand(io(), [await packageRootIn(unpacked), '--pub', pub])).toBe(0);
  });
});

describe('permissions', () => {
  test('the reader example plugin', async () => {
    const fake = io();
    expect(await permissionsCommand(fake, [join(ROOT, 'plugins/reader'), '--json'])).toBe(0);
    expect(jsonOut(fake)).toMatchInlineSnapshot({ ui: { dir: 'ui', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } }, `
      {
        "apiVersion": "1.0.0",
        "contributions": {
          "commands": [],
          "context": null,
          "events": [],
          "prompt": null,
          "schedules": [],
        },
        "effects": {
          "external": 0,
          "read": 2,
          "write": 2,
        },
        "host": [
          "model:complete",
          "notes:write",
          "tasks:write",
          "web:read",
        ],
        "maxProtection": 1,
        "name": "reader",
        "network": [],
        "pages": [
          {
            "entry": "index.html",
            "path": "read",
            "title": "Reader",
          },
        ],
        "runtime": "package",
        "secrets": [],
        "settings": [],
        "store": null,
        "tools": [
          {
            "effect": "write",
            "name": "create_tasks",
          },
          {
            "effect": "read",
            "name": "read_url",
          },
          {
            "effect": "read",
            "name": "reader_action",
          },
          {
            "effect": "write",
            "name": "save_note",
          },
        ],
        "trustedInput": false,
        "ui": {
          "dir": "ui",
          "sha256": StringMatching /\\^\\[0-9a-f\\]\\{64\\}\\$/,
        },
        "version": "1.0.0",
      }
    `);
  });

  test('the research example plugin', async () => {
    const fake = io();
    expect(await permissionsCommand(fake, [join(ROOT, 'plugins/research'), '--json'])).toBe(0);
    expect(jsonOut(fake)).toMatchInlineSnapshot({ ui: { dir: 'ui', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } }, `
      {
        "apiVersion": "1.0.0",
        "contributions": {
          "commands": [],
          "context": null,
          "events": [],
          "prompt": null,
          "schedules": [],
        },
        "effects": {
          "external": 0,
          "read": 1,
          "write": 2,
        },
        "host": [
          "agent:run",
          "documents:write",
        ],
        "maxProtection": 1,
        "name": "research",
        "network": [],
        "pages": [
          {
            "entry": "index.html",
            "path": "run",
            "title": "Research",
          },
        ],
        "runtime": "package",
        "secrets": [],
        "settings": [],
        "store": null,
        "tools": [
          {
            "effect": "read",
            "name": "research_status",
          },
          {
            "effect": "write",
            "name": "save_report",
          },
          {
            "effect": "write",
            "name": "start_research",
          },
        ],
        "trustedInput": false,
        "ui": {
          "dir": "ui",
          "sha256": StringMatching /\\^\\[0-9a-f\\]\\{64\\}\\$/,
        },
        "version": "1.0.0",
      }
    `);
  });

  test('the keys come in the documented order, and packagePermissions is what the command prints', async () => {
    const dir = join(ROOT, 'plugins/research');
    const fake = io();
    await permissionsCommand(fake, [dir, '--json']);
    const printed = jsonOut(fake);
    expect(Object.keys(printed)).toEqual(['name', 'version', 'apiVersion', 'runtime', 'host', 'network', 'secrets', 'settings', 'store', 'tools', 'effects', 'contributions', 'pages', 'ui', 'trustedInput', 'maxProtection']);
    expect(Object.keys(printed.contributions as object)).toEqual(['commands', 'schedules', 'events', 'prompt', 'context']);
    expect(printed).toEqual(await packagePermissions(parseManifest(JSON.parse(readFileSync(join(dir, 'octipus-plugin.json'), 'utf8'))), dir));
    // The page tree hash is over the ui directory's files, so another byte there changes it.
    expect((printed.ui as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('lists are sorted, contributions and the default maxProtection are counted', () => {
    const p = computePermissions(parseManifest({
      name: 'weekly', version: '1.0.0', apiVersion: '1.0.0', title: 'Weekly', description: 'Weekly review',
      server: { command: 'node', args: ['s.mjs'] },
      tools: { zeta: { effect: 'external' }, alpha: { effect: 'read' }, mid: { effect: 'write' } },
      host: ['tasks:read'],
      network: ['b.example.com', 'a.example.com'],
      commands: [{ name: 'zz', tool: 'alpha', description: 'z' }, { name: 'aa', tool: 'alpha', description: 'a' }],
      schedules: [{ id: 'weekly', cron: '0 9 * * 1', tool: 'mid', input: { full: true } }],
      events: [{ on: 'document.failed', tool: 'mid' }, { on: 'chat.response', tool: 'alpha' }],
      prompt: { file: 'notes.md', roles: ['writer', 'general'] },
      context: { tool: 'alpha' },
    }));
    expect(p.tools.map((t) => t.name)).toEqual(['alpha', 'mid', 'zeta']);
    expect(p.effects).toEqual({ read: 1, write: 1, external: 1 });
    expect(p.network).toEqual(['a.example.com', 'b.example.com']);
    expect(p.contributions).toEqual({
      commands: [{ name: 'aa', tool: 'alpha' }, { name: 'zz', tool: 'alpha' }],
      schedules: [{ id: 'weekly', cron: '0 9 * * 1', tool: 'mid', input: { full: true } }],
      events: [{ on: 'chat.response', tool: 'alpha' }, { on: 'document.failed', tool: 'mid' }],
      // From a manifest alone the prompt file is not hashed.
      prompt: { file: 'notes.md', sha256: null, roles: ['general', 'writer'] },
      context: { tool: 'alpha' },
    });
    expect(p.pages).toEqual([]);
    expect(p.ui).toBeNull();
    expect(p.maxProtection).toBe(1);
  });

  test('a manifest install would refuse is refused', async () => {
    const dir = fixture();
    writeFileSync(join(dir, 'octipus-plugin.json'), '{"name":"x"}');
    const fake = io();
    expect(await permissionsCommand(fake, [dir, '--json'])).toBe(1);
    expect(fake.stdout).toBe('');
  });
});

describe('verify', () => {
  test('valid; then tampered content, another key and no signature are not', async () => {
    const { key, pub } = await keys();
    const other = await keys();
    const dir = fixture();
    expect(await signCommand(io(), [dir, '--key', key])).toBe(0);
    expect(await verifyCommand(io(), [dir, '--pub', pub])).toBe(0);

    const stranger = io();
    expect(await verifyCommand(stranger, [dir, '--pub', other.pub, '--json'])).toBe(1);
    expect(jsonOut(stranger)).toMatchObject({ valid: false, error: expect.stringMatching(/not the key/) });
    // Any one of several keys is enough.
    expect(await verifyCommand(io(), [dir, '--pub', other.pub, '--pub', pub])).toBe(0);

    writeFileSync(join(dir, 'server.mjs'), `${readFileSync(join(dir, 'server.mjs'), 'utf8')}\n// changed\n`);
    const tampered = io();
    expect(await verifyCommand(tampered, [dir, '--pub', pub, '--json'])).toBe(1);
    const report = jsonOut(tampered);
    expect(report).toMatchObject({ valid: false, error: expect.stringMatching(/does not match/) });
    expect(Object.keys(report)).toEqual(['valid', 'keyId', 'contentHash', 'error']);

    rmSync(join(dir, 'octipus-plugin.sig'));
    const unsigned = io();
    expect(await verifyCommand(unsigned, [dir, '--pub', pub, '--json'])).toBe(1);
    expect(jsonOut(unsigned)).toMatchObject({ valid: false, keyId: null, error: expect.stringMatching(/not signed/) });
  });

  test('a listing edit after signing keeps the signature valid', async () => {
    const { key, pub } = await keys();
    const dir = fixture();
    writeFileSync(join(dir, 'marketplace.json'), '{"title":"one"}');
    expect(await signCommand(io(), [dir, '--key', key])).toBe(0);
    writeFileSync(join(dir, 'marketplace.json'), '{"title":"two"}');
    expect(await verifyCommand(io(), [dir, '--pub', pub])).toBe(0);
  });
});

describe('verify-index', () => {
  test('passes when any one key verifies and names it; a changed index or another key fails', async () => {
    const acme = await keys('index pass');
    const backup = await keys();
    const index = join(temp(), 'index.json');
    writeFileSync(index, '{"schema":2,"packages":[]}\n');
    const signed = io();
    expect(await signIndexCommand(signed, [index, '--key', acme.key, '--passphrase-file', passFile('index pass'), '--json'])).toBe(0);
    const { keyId, sha256 } = jsonOut(signed);

    const ok = io();
    expect(await verifyIndexCommand(ok, [index, '--pub', backup.pub, '--pub', acme.pub, '--json'])).toBe(0);
    expect(jsonOut(ok)).toEqual({ valid: true, keyId, pub: acme.pub, sha256 });

    const wrongKey = io();
    expect(await verifyIndexCommand(wrongKey, [index, '--pub', backup.pub, '--json'])).toBe(1);
    expect(jsonOut(wrongKey)).toMatchObject({ valid: false, keyId, pub: null });

    // One byte more (a re-serialisation, say) is another index.
    writeFileSync(index, '{"schema":2,"packages":[]}\n\n');
    const tampered = io();
    expect(await verifyIndexCommand(tampered, [index, '--pub', acme.pub, '--json'])).toBe(1);
    expect(jsonOut(tampered)).toMatchObject({ valid: false, error: expect.stringMatching(/does not match the registry index/) });

    rmSync(`${index}.sig`);
    const unsigned = io();
    expect(await verifyIndexCommand(unsigned, [index, '--pub', acme.pub, '--json'])).toBe(1);
    expect(jsonOut(unsigned)).toMatchObject({ valid: false, error: expect.stringMatching(/not signed/) });
    expect(await verifyIndexCommand(io(), [index])).toBe(2);
  });
});

describe('validate', () => {
  test('a package: ok, or every problem; exit 1 when not ok', async () => {
    const fake = io();
    expect(await validateCommand(fake, [join(ROOT, 'plugins/reader'), '--json'])).toBe(0);
    expect(jsonOut(fake)).toEqual({ ok: true, problems: [], warnings: [] });

    const dir = fixture();
    const manifest = JSON.parse(readFileSync(join(dir, 'octipus-plugin.json'), 'utf8'));
    writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify({ ...manifest, server: { command: 'node', args: ['missing.mjs'] } }));
    const broken = io();
    expect(await validateCommand(broken, [dir, '--json'])).toBe(1);
    const report = jsonOut(broken);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([expect.stringMatching(/missing\.mjs is not a file in the package/)]);

    writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify({ ...manifest, runtime: 'in-process' }));
    const inProcess = io();
    expect(await validateCommand(inProcess, [dir, '--json'])).toBe(1);
    expect((jsonOut(inProcess).problems as string[]).some((p) => p.includes('runtime "in-process"'))).toBe(true);
  });

  test('a directory with no manifest is not ok', async () => {
    const fake = io();
    expect(await validateCommand(fake, [temp(), '--json'])).toBe(1);
    expect(jsonOut(fake)).toMatchObject({ ok: false, problems: [expect.stringMatching(/No octipus-plugin.json/)] });
  });
});

describe('marketplace keys files and unpacking (review finding 12, marketplace repo commands)', () => {
  // Generated now, expiring in 30 days (keys.json must expire, at most 90 days after it was generated).
  const keysJson = (over: Record<string, unknown> = {}) => JSON.stringify({
    schema: 1, version: 1, generatedAt: new Date().toISOString(), expires: new Date(Date.now() + 30 * 86_400_000).toISOString(), signingKeys: [], revokedKeys: [], ...over,
  });
  async function rootKeys(): Promise<{ root: { key: string; pub: string; id: string }; backup: { key: string; pub: string; id: string }; signing: { key: string; pub: string; id: string } }> {
    const make = async (name: string) => {
      const prefix = join(temp('octipus-offline-root-'), name);
      const fake = io();
      expect(await keygenCommand(fake, [prefix, '--json'])).toBe(0);
      return { key: `${prefix}.key`, pub: `${prefix}.pub`, id: jsonOut(fake).keyId as string };
    };
    return { root: await make('root'), backup: await make('backup'), signing: await make('signing') };
  }

  test('keygen warns loudly about an unencrypted key, and still writes it', async () => {
    const prefix = join(temp(), 'plain');
    const fake = io();
    expect(await keygenCommand(fake, [prefix])).toBe(0);
    expect(fake.stderr).toMatch(/WARNING: the private key is written UNENCRYPTED/);
    expect(existsSync(`${prefix}.key`)).toBe(true);
    const encrypted = io();
    expect(await keygenCommand(encrypted, [join(temp(), 'enc'), '--passphrase-file', passFile('secret')])).toBe(0);
    expect(encrypted.stderr).not.toMatch(/UNENCRYPTED/);
  });

  test('sign-keys checks the file as a host reads it before signing: schema, no root as a signing key, not expired', async () => {
    const { root, backup, signing } = await rootKeys();
    const file = join(temp(), 'keys.json');
    const entry = (k: { pub: string; id: string }) => ({ keyId: k.id, publicKey: readFileSync(k.pub, 'utf8') });
    const refused = async (content: string, extra: string[] = []) => {
      writeFileSync(file, content);
      rmSync(`${file}.sig`, { force: true });
      const fake = io();
      expect(await signKeysCommand(fake, [file, '--key', root.key, ...extra])).toBe(1);
      expect(existsSync(`${file}.sig`)).toBe(false);
      return fake.stderr;
    };
    expect(await refused(keysJson({ version: 1.5 }))).toMatch(/version/);
    expect(await refused(keysJson({ extra: true }))).toMatch(/schema/);
    expect(await refused(keysJson({ signingKeys: [entry(root)] }))).toMatch(/root key/);
    expect(await refused(keysJson({ signingKeys: [entry(backup)] }), ['--root-pub', backup.pub])).toMatch(/root key/);
    expect(await refused(keysJson({ generatedAt: '2019-12-15T00:00:00Z', expires: '2020-01-01T00:00:00Z' }))).toMatch(/expired/);
    expect(await refused(keysJson({ expires: undefined }))).toMatch(/expires/);
    expect(await refused(keysJson({ expires: '2099-01-01T00:00:00Z' }))).toMatch(/at most 90 days/);
    writeFileSync(file, keysJson({ signingKeys: [entry(signing)] }));
    expect(await signKeysCommand(io(), [file, '--key', root.key, '--root-pub', backup.pub])).toBe(0);
  });

  test('verify-keys reports the signer, version, endorsed and revoked keys, and refuses what a host refuses', async () => {
    const { root, backup, signing } = await rootKeys();
    const file = join(temp(), 'keys.json');
    const entry = { keyId: signing.id, publicKey: readFileSync(signing.pub, 'utf8') };
    writeFileSync(file, keysJson({ version: 3, signingKeys: [entry], revokedKeys: [{ keyId: `ed25519:${'1'.repeat(64)}`, reason: 'old' }] }));
    expect(await signKeysCommand(io(), [file, '--key', root.key])).toBe(0);
    let fake = io();
    expect(await verifyKeysCommand(fake, [file, '--root-pub', root.pub, '--root-pub', backup.pub, '--json'])).toBe(0);
    expect(jsonOut(fake)).toEqual({ valid: true, keyId: root.id, version: 3, endorsed: [signing.id], revoked: [`ed25519:${'1'.repeat(64)}`] });

    // Signed by a key that is not a root given.
    fake = io();
    expect(await verifyKeysCommand(fake, [file, '--root-pub', backup.pub, '--json'])).toBe(1);
    expect(jsonOut(fake)).toMatchObject({ valid: false, keyId: root.id, error: expect.stringMatching(/none of the roots/) });

    // The root may never revoke the backup.
    writeFileSync(file, keysJson({ revokedKeys: [{ keyId: backup.id }] }));
    expect(await signKeysCommand(io(), [file, '--key', root.key])).toBe(0);
    fake = io();
    expect(await verifyKeysCommand(fake, [file, '--root-pub', root.pub, '--root-pub', backup.pub, '--json'])).toBe(1);
    expect(jsonOut(fake)).toMatchObject({ valid: false, error: expect.stringMatching(/may not revoke the rootBackup/) });

    // Changed after signing.
    writeFileSync(file, keysJson({ version: 9 }));
    fake = io();
    expect(await verifyKeysCommand(fake, [file, '--root-pub', root.pub, '--json'])).toBe(1);
    expect(jsonOut(fake)).toMatchObject({ valid: false, error: expect.any(String) });
    expect(await verifyKeysCommand(io(), [file])).toBe(2);
  });

  test('unpack uses the strict tar reader: a packed package round-trips; an escaping path or a non-empty --out is refused', async () => {
    const out = temp();
    const packed = join(out, 'echo.tar.gz');
    expect(await packCommand(io(), [fixture(), '--out', packed])).toBe(0);
    const target = join(temp(), 'unpacked');
    const fake = io();
    expect(await unpackCommand(fake, [packed, '--out', target, '--json'])).toBe(0);
    const result = jsonOut(fake);
    expect(result).toMatchObject({ out: target, name: 'echo-plugin', sha256: `sha256:${createHash('sha256').update(readFileSync(packed)).digest('hex')}` });
    expect(existsSync(join(result.root as string, 'octipus-plugin.json'))).toBe(true);
    expect(await unpackCommand(io(), [packed, '--out', target])).toBe(1);

    const evil = join(out, 'evil.tar.gz');
    writeFileSync(evil, makeTarGz([{ name: '../escape.txt', data: 'x' }]));
    const refused = io();
    expect(await unpackCommand(refused, [evil, '--out', join(temp(), 'e')])).toBe(1);
    expect(existsSync(join(out, '..', 'escape.txt'))).toBe(false);
    expect(await unpackCommand(io(), [evil])).toBe(2);
  });
});
