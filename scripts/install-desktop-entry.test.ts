import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Linux launcher and sized theme icons share the GTK application identity', () => {
  const dataHome = mkdtempSync(join(tmpdir(), 'octipus-launcher-'));
  try {
    execFileSync(process.execPath, ['scripts/install-desktop-entry.mjs'], {
      cwd: resolve('.'), env: { ...process.env, XDG_DATA_HOME: dataHome }, stdio: 'pipe',
    });
    const config = JSON.parse(readFileSync('web/src-tauri/tauri.conf.json', 'utf8'));
    expect(config.app.enableGTKAppId).toBe(true);
    const entry = readFileSync(join(dataHome, 'applications', `${config.identifier}.desktop`), 'utf8');
    expect(entry).toContain(`Icon=${config.identifier}\n`);
    expect(entry).toContain('StartupWMClass=Octipus\n');
    expect(entry).toContain(`Exec="${resolve('bin/octi')}" desktop\n`);
    for (const size of [32, 128, 256, 512]) {
      const png = readFileSync(join(dataHome, 'icons', 'hicolor', `${size}x${size}`, 'apps', `${config.identifier}.png`));
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    expect(readFileSync('web/src-tauri/Cargo.toml', 'utf8')).toMatch(/\[package\]\nname = "octipus"/);
  } finally { rmSync(dataHome, { recursive: true, force: true }); }
});
