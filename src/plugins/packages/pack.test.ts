/**
 * Reproducible package tarballs (docs/PLUGIN-PACKAGES.md#packing-and-publishing):
 * the same files give the same bytes whatever their timestamps, owners or the
 * order they were written in; the archive is plain ustar under
 * `<name>-<version>/` with fixed metadata; and what it holds unpacks through
 * the remote-install reader to a directory with the same content hash.
 */
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'vitest';
import { hashPackageContent } from './integrity';
import { packPackage } from './pack';
import { extractTarGz, packageRootIn, readTarEntries } from './tar';

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MANIFEST = {
  name: 'demo', version: '1.2.0', apiVersion: '1.0.0', title: 'Demo', description: 'A demo package',
  server: { command: 'node', args: ['server.mjs'] },
  tools: { ping: { effect: 'read' } },
};
const LONG = `${'deep/'.repeat(25)}file-with-a-long-name.js`;

/** A package directory, its files written in the order given. */
function pkg(extra: Array<[string, string]> = [], order: 'forward' | 'reverse' = 'forward'): string {
  const dir = temp('octipus-pack-');
  const files: Array<[string, string]> = [
    ['octipus-plugin.json', JSON.stringify(MANIFEST)],
    ['server.mjs', 'console.log("hi")\n'],
    ['lib/a.js', 'export const a = 1;\n'],
    ['bin/run.sh', '#!/bin/sh\necho run\n'],
    [LONG, 'long\n'],
    ...extra,
  ];
  for (const [rel, content] of order === 'forward' ? files : [...files].reverse()) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  chmodSync(join(dir, 'bin/run.sh'), 0o755);
  mkdirSync(join(dir, 'empty'));
  return dir;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    out.push(r);
    if (e.isDirectory()) out.push(...await walk(dir, r));
  }
  return out.sort();
}

describe('packPackage', () => {
  test('packing twice gives the same bytes; so do other mtimes and another write order', async () => {
    const dir = pkg();
    const first = await packPackage(dir);
    const second = await packPackage(dir);
    expect(second.sha256).toBe(first.sha256);
    expect(sha(second.tarball)).toBe(sha(first.tarball));
    expect(first.sha256).toBe(sha(first.tarball));

    // Timestamps normalised: new mtimes and atimes on every file and directory change nothing.
    for (const rel of await walk(dir)) utimesSync(join(dir, rel), new Date('2001-02-03T04:05:06Z'), new Date('2031-01-01T00:00:00Z'));
    utimesSync(dir, new Date(0), new Date(1_000_000_000_000));
    expect((await packPackage(dir)).sha256).toBe(first.sha256);

    // The same files written in the reverse order, in another place.
    expect((await packPackage(pkg([], 'reverse'))).sha256).toBe(first.sha256);
  });

  test('the archive is ustar under <name>-<version>/, sorted, with mtime 0, owner 0, empty names and fixed modes', async () => {
    const { tarball, root } = await packPackage(pkg());
    expect(root).toBe('demo-1.2.0');
    // gzip: no FNAME flag, mtime 0, OS byte 255, the same on every platform.
    expect([...tarball.subarray(0, 10)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff]);
    const tar = gunzipSync(tarball);
    const headers: Array<{ name: string; mode: string; uid: string; gid: string; mtime: string; uname: string; gname: string; type: string; magic: string }> = [];
    for (let off = 0; off + 512 <= tar.length;) {
      const h = tar.subarray(off, off + 512);
      if (h.every((b) => b === 0)) break;
      const field = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
      const size = Number.parseInt(field(124, 12), 8);
      const prefix = field(345, 155);
      headers.push({
        name: prefix ? `${prefix}/${field(0, 100)}` : field(0, 100), mode: field(100, 8), uid: field(108, 8), gid: field(116, 8),
        mtime: field(136, 12), uname: field(265, 32), gname: field(297, 32), type: field(156, 1), magic: field(257, 6),
      });
      off += 512 + Math.ceil(size / 512) * 512;
    }
    for (const h of headers) {
      expect([h.uid, h.gid, h.mtime, h.uname, h.gname, h.magic]).toEqual(['0000000', '0000000', '00000000000', '', '', 'ustar']);
    }
    const entries = headers.filter((h) => h.type !== 'x');
    // The long path fits ustar's prefix and name fields: no pax header needed.
    expect(headers.some((h) => h.type === 'x')).toBe(false);
    expect(entries.map((h) => [h.name, h.type, h.mode])).toEqual([
      ['demo-1.2.0/', '5', '0000755'],
      ['demo-1.2.0/bin/', '5', '0000755'],
      ['demo-1.2.0/bin/run.sh', '0', '0000755'],
      ...LONG.split('/').slice(0, -1).map((_, i, parts) => [`demo-1.2.0/${parts.slice(0, i + 1).join('/')}/`, '5', '0000755']),
      [`demo-1.2.0/${LONG}`, '0', '0000644'],
      ['demo-1.2.0/empty/', '5', '0000755'],
      ['demo-1.2.0/lib/', '5', '0000755'],
      ['demo-1.2.0/lib/a.js', '0', '0000644'],
      ['demo-1.2.0/octipus-plugin.json', '0', '0000644'],
      ['demo-1.2.0/server.mjs', '0', '0000644'],
    ]);
  });

  test('a path too long for ustar gets a pax header, which the install reader takes', async () => {
    const longName = `${'n'.repeat(120)}.js`;
    const { tarball } = await packPackage(pkg([[`lib/${longName}`, 'x']]));
    const entries = readTarEntries(gunzipSync(tarball));
    expect(entries.some((e) => e.path === `demo-1.2.0/lib/${longName}`)).toBe(true);
  });

  test('pack, then the remote-install reader, then hashPackageContent gives the content hash; the signature is packed, the listing file is not', async () => {
    const dir = pkg([['marketplace.json', '{"title":"Demo"}'], ['octipus-plugin.sig', 'not checked here\n']]);
    const packed = await packPackage(dir);
    expect(packed.contentHash).toBe(await hashPackageContent(dir, MANIFEST, { source: true }));

    const out = temp('octipus-pack-out-');
    await extractTarGz(packed.tarball, out);
    const root = await packageRootIn(out);
    expect(root).toBe(join(out, 'demo-1.2.0'));
    expect(existsSync(join(root, 'marketplace.json'))).toBe(false);
    expect(existsSync(join(root, 'octipus-plugin.sig'))).toBe(true);
    expect(existsSync(join(root, 'empty'))).toBe(true);
    expect(statSync(join(root, 'bin/run.sh')).mode & 0o777).toBe(0o755);
    // The unpacked directory, hashed as an installed one (nothing left out), is what was packed.
    expect(await hashPackageContent(root, MANIFEST)).toBe(packed.contentHash);

    // A listing edit changes neither the tarball nor the hash.
    writeFileSync(join(dir, 'marketplace.json'), '{"title":"Demo, renamed"}');
    const again = await packPackage(dir);
    expect([again.sha256, again.contentHash]).toEqual([packed.sha256, packed.contentHash]);
    // Any package byte does.
    writeFileSync(join(dir, 'lib/a.js'), 'export const a = 2;\n');
    expect((await packPackage(dir)).sha256).not.toBe(packed.sha256);
  });

  test('refuses what install refuses: a symbolic link, a bad manifest', async () => {
    const linked = pkg();
    const { symlinkSync } = await import('node:fs');
    symlinkSync('/etc/passwd', join(linked, 'lib/passwd'));
    await expect(packPackage(linked)).rejects.toThrow(/symbolic link/);

    const bad = temp('octipus-pack-bad-');
    cpSync(pkg(), bad, { recursive: true });
    writeFileSync(join(bad, 'octipus-plugin.json'), JSON.stringify({ ...MANIFEST, name: 'Bad Name' }));
    await expect(packPackage(bad)).rejects.toThrow(/name/);
  });
});
