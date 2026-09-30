import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--dry-run')) {
  console.error('Usage: octi update [--dry-run]'); process.exit(2);
}
const dryRun = args.includes('--dry-run');
function run(command, argv) {
  console.log(`> ${command} ${argv.join(' ')}`);
  if (dryRun) return;
  const result = command === 'npm' && process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `npm ${argv.join(' ')}`], { cwd: root, stdio: 'inherit' })
    : spawnSync(command, argv, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.error?.message ?? result.status}); update stopped.`);
}
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (existsSync(join(root, '.git'))) {
    const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
    const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
    const upstream = git('rev-parse', '--abbrev-ref', '@{upstream}');
    console.log(`Repository installation: ${root}\nUpdating ${branch} from ${upstream}.`);
    if (!dryRun && git('status', '--porcelain')) throw new Error('Checkout has local changes. Commit or stash them before updating.');
    run('git', ['pull', '--ff-only']);
    run('npm', ['ci', '--include=dev']);
    run('npm', ['--prefix', 'web', 'ci', '--include=dev']);
    run('npm', ['--prefix', 'mcp-server', 'ci', '--include=dev']);
    run('npm', ['run', 'build']);
    run('npm', ['run', 'build:cli']);
    run('npm', ['--prefix', 'web', 'run', 'build']);
    run('npm', ['--prefix', 'mcp-server', 'run', 'build']);
  } else {
    if (pkg.private || !/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(pkg.name)) {
      throw new Error('This installation is neither a Git checkout nor a published npm package. Update it with its original installer.');
    }
    // Never guess an unrelated registry package for a source installation.
    const prefix = execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'npm',
      process.platform === 'win32' ? ['/d', '/s', '/c', 'npm root -g'] : ['root', '-g'], { encoding: 'utf8' }).trim();
    const globalRoot = resolve(prefix, pkg.name);
    const normalize = path => process.platform === 'win32' ? path.toLowerCase() : path;
    if (normalize(globalRoot) !== normalize(root)) throw new Error(`Local npm installation. Run npm install ${pkg.name}@latest in the owning project.`);
    run('npm', ['install', '--global', `${pkg.name}@latest`]);
  }
  console.log(dryRun ? 'Preview only; no changes made.' : 'Update complete. Run octi restart to activate it.');
} catch (error) { console.error(`octi update: ${error.message}`); process.exitCode = 1; }
