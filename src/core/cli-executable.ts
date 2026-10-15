import { accessSync, constants, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getConfig } from '@/config';
import { coreLogger } from '@/utils/logger';

export function resolveExecutable(binary: string, path = process.env.PATH ?? ''): string {
  const candidates = isAbsolute(binary) || /[/\\]/.test(binary)
    ? [resolve(binary)] : path.split(delimiter).filter(Boolean).map(dir => resolve(dir, binary));
  const suffixes = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const candidate of candidates) for (const suffix of suffixes) {
    const executable = candidate + suffix;
    try {
      accessSync(executable, constants.X_OK);
      if (statSync(executable).isFile()) return executable;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error(`CLI executable "${binary}" was not found or is not executable. Searched PATH=${path}. Configure cliModels binaryPath and cliModels.path, then restart Octipus.`);
}

export function configuredCliBinary(binary: string): string {
  const config = getConfig().cliModels;
  const configured = binary === 'claude' ? config.claudeCode.binaryPath
    : binary === 'codex' ? config.codexCli.binaryPath
      : binary === 'agy' ? config.antigravityCli.binaryPath : binary;
  return resolveExecutable(configured, config.path || process.env.PATH);
}

export function cliExecutableHealth() {
  const config = getConfig().cliModels;
  return Object.entries({ claude: config.claudeCode, codex: config.codexCli, agy: config.antigravityCli })
    .map(([name, tool]) => {
      try { return { name, status: 'healthy', path: resolveExecutable(tool.binaryPath, config.path || process.env.PATH) }; }
      catch (error) { return { name, status: 'unhealthy', message: error instanceof Error ? error.message : String(error) }; }
    });
}

/** Snapshot the user's login PATH once; children inherit it through their existing allowlist. */
export function initializeCliExecutables(): void {
  const configured = getConfig().cliModels.path || undefined;
  let loginPath: string | undefined;
  if (!configured && process.platform !== 'win32') {
    try {
      const output = execFileSync(process.env.SHELL || '/bin/sh', ['-lc', 'printf "\\nOCTIPUS_LOGIN_PATH=%s\\n" "$PATH"'],
        { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      loginPath = output.match(/^OCTIPUS_LOGIN_PATH=(.*)$/m)?.[1];
    } catch (error) { coreLogger.warn({ error }, 'Could not read login PATH; using server PATH and standard user CLI directories'); }
  }
  process.env.PATH = configured ?? [...new Set([
    ...(loginPath ?? process.env.PATH ?? '').split(delimiter).filter(Boolean),
    ...(process.platform === 'win32' ? [] : [join(homedir(), '.local/bin'), join(homedir(), '.npm-global/bin')]),
  ])].join(delimiter);
  for (const health of cliExecutableHealth()) {
    if (health.status === 'unhealthy') coreLogger.warn(health, 'CLI startup configuration check failed');
    else coreLogger.info(health, 'CLI executable resolved');
  }
}
