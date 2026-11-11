/** Build the application-owned helper. Never download/execute a PATH substitute. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('Build octipus-sandbox.exe on Windows (Windows CI builds and tests release artifacts).');
const result = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', join(root, 'native/windows-sandbox/Cargo.toml')], { stdio: 'inherit', shell: false });
if (result.error) throw new Error(`Native plugin sandbox requires Rust and Visual Studio C++ Build Tools: ${result.error.message}`);
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync(join(root, 'native/bin'), { recursive: true });
copyFileSync(join(root, 'native/windows-sandbox/target/release/octipus-sandbox.exe'), join(root, 'native/bin/octipus-sandbox.exe'));
