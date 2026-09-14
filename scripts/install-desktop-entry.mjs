#!/usr/bin/env node
// Register the checkout's desktop client in the user's Linux application/icon
// theme directories. Tauri's GTK ID, desktop filename, and icon name must agree.
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configured = process.env.XDG_DATA_HOME;
const dataHome = configured && isAbsolute(configured) ? configured : join(homedir(), '.local', 'share');
const appId = 'cc.octipus.desktop';
const applications = join(dataHome, 'applications');
// Desktop Exec quoting is not shell quoting (and % has field-code semantics).
const executable = join(repo, 'bin', 'octi').replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%');
await mkdir(applications, { recursive: true });
for (const size of [32, 128, 256, 512]) {
  const directory = join(dataHome, 'icons', 'hicolor', `${size}x${size}`, 'apps');
  await mkdir(directory, { recursive: true });
  const source = size === 256 ? '128x128@2x.png' : size === 512 ? 'icon.png' : `${size}x${size}.png`;
  await copyFile(join(repo, 'web', 'src-tauri', 'icons', source), join(directory, `${appId}.png`));
}
await writeFile(join(applications, `${appId}.desktop`), `[Desktop Entry]
Version=1.0
Type=Application
Name=Octipus
Comment=Octipus desktop client
Exec="${executable}" desktop
Icon=${appId}
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=Octipus
`, { mode: 0o644 });
for (const [command, args] of [
  ['update-desktop-database', [applications]],
  ['gtk-update-icon-cache', ['--force', '--ignore-theme-index', join(dataHome, 'icons', 'hicolor')]],
]) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error && result.error.code !== 'ENOENT') console.warn(`${command}: ${result.error.message}`);
  else if (result.status !== null && result.status !== 0) console.warn(`${command}: ${result.stderr.trim()}`);
}
console.log(`Registered Octipus desktop launcher in ${applications}`);
