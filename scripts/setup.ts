#!/usr/bin/env bun
/**
 * Interactive setup wizard — generates bootstrap .env file.
 * All other configuration (LLM, channels, workspace, etc.) is done
 * via the web UI at http://localhost:3007/setup after first boot.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { input, select, confirm, checkbox } from '@inquirer/prompts';

// ── Helpers ──

function generateSecureKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

async function checkTcpPort(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: host, port, socket: {
      data() {},
      open(socket) { socket.end(); },
      error() {},
    }});
    return true;
  } catch {
    return false;
  }
}

async function checkHttp(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}

async function detectChromium(): Promise<string | null> {
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try {
      const proc = Bun.spawn(['which', bin], { stdout: 'pipe', stderr: 'pipe' });
      const code = await proc.exited;
      if (code === 0) {
        const path = (await new Response(proc.stdout).text()).trim();
        return path || bin;
      }
    } catch {}
  }
  return null;
}

// ── Main ──

async function main(): Promise<void> {
  console.log(`
\x1b[36m╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║     █████╗ ███████╗███████╗██╗███████╗████████╗          ║
║    ██╔══██╗██╔════╝██╔════╝██║██╔════╝╚══██╔══╝          ║
║    ███████║███████╗███████╗██║███████╗   ██║             ║
║    ██╔══██║╚════██║╚════██║██║╚════██║   ██║             ║
║    ██║  ██║███████║███████║██║███████║   ██║             ║
║    ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝╚══════╝   ╚═╝             ║
║                                                           ║
║              Setup Wizard                                 ║
╚═══════════════════════════════════════════════════════════╝\x1b[0m
`);

  // Check if .env already exists
  if (existsSync('.env')) {
    const overwrite = await confirm({ message: '.env already exists. Overwrite?', default: false });
    if (!overwrite) {
      console.log('Setup cancelled.');
      return;
    }
  }

  console.log('This wizard creates a bootstrap .env file.');
  console.log('All other configuration is done via the web UI after first boot.\n');

  // ── Auto-detect services ──
  console.log('\x1b[90mDetecting services...\x1b[0m');
  const [pgAvailable, redisAvailable, ollamaAvailable, chromiumPath] = await Promise.all([
    checkTcpPort('localhost', 5432),
    checkTcpPort('localhost', 6379),
    checkHttp('http://localhost:11434/api/tags'),
    detectChromium(),
  ]);

  if (pgAvailable || redisAvailable || ollamaAvailable || chromiumPath) {
    const detected: string[] = [];
    if (pgAvailable) detected.push('PostgreSQL (5432)');
    if (redisAvailable) detected.push('Redis (6379)');
    if (ollamaAvailable) detected.push('Ollama (11434)');
    if (chromiumPath) detected.push(`Chromium (${chromiumPath})`);
    console.log(`\x1b[32m✓ Detected:\x1b[0m ${detected.join(', ')}\n`);
  } else {
    console.log('\x1b[33m✗ No external services detected\x1b[0m\n');
  }

  // ── Storage mode ──
  const defaultMode = (pgAvailable && redisAvailable) ? 'external' : 'embedded';

  const storageMode = await select({
    message: 'Infrastructure mode',
    choices: [
      {
        value: 'embedded',
        name: 'Embedded (PGlite + in-memory cache)',
        description: 'Zero external dependencies. Data stored locally. Best for personal use / getting started.',
      },
      {
        value: 'external',
        name: 'External (PostgreSQL + Redis)',
        description: 'Full production setup. Requires PostgreSQL and Redis running.',
      },
    ],
    default: defaultMode,
  });

  let databaseUrl = '';
  let redisUrl = '';
  let dataDir = '~/.assistant/data';

  if (storageMode === 'external') {
    // ── Database ──
    console.log('\n\x1b[1m── Database ──\x1b[0m');
    const dbHost = await input({ message: 'PostgreSQL host', default: 'localhost' });
    const dbPort = await input({ message: 'PostgreSQL port', default: '5432' });
    const dbName = await input({ message: 'Database name', default: 'assistant' });
    const dbUser = await input({ message: 'Database user', default: 'assistant' });
    const dbPassword = await input({ message: 'Database password' });
    databaseUrl = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;

    // ── Redis ──
    console.log('\n\x1b[1m── Redis ──\x1b[0m');
    const redisHost = await input({ message: 'Redis host', default: 'localhost' });
    const redisPort = await input({ message: 'Redis port', default: '6379' });
    const redisPassword = await input({ message: 'Redis password (empty if none)', default: '' });
    redisUrl = redisPassword
      ? `redis://:${redisPassword}@${redisHost}:${redisPort}`
      : `redis://${redisHost}:${redisPort}`;
  } else {
    // Embedded mode
    dataDir = await input({ message: 'Data directory', default: '~/.assistant/data' });
  }

  // ── API ──
  console.log('\n\x1b[1m── API Server ──\x1b[0m');
  const port = await input({ message: 'API port', default: '3005' });
  const host = await input({ message: 'API host', default: '127.0.0.1' });

  // ── Security keys (auto-generated) ──
  console.log('\n\x1b[1m── Security ──\x1b[0m');
  const masterKey = generateSecureKey();
  const jwtSecret = generateSecureKey();
  const sessionSecret = generateSecureKey();
  console.log('Security keys auto-generated (32 bytes each).');

  // ── Optional extras ──
  console.log('');
  const extras = await checkbox({
    message: 'Install optional extras?',
    choices: [
      {
        value: 'playwright',
        name: 'Playwright (browser automation for QA agent)',
        checked: false,
      },
      {
        value: 'ollama',
        name: 'Ollama (local LLM inference)',
        checked: false,
        disabled: ollamaAvailable ? '(already running)' : false,
      },
      ...(chromiumPath ? [{
        value: 'browser-ext' as const,
        name: 'Browser Extension (real browser control for AI agents)',
        checked: false,
      }] : []),
      {
        value: 'mcp',
        name: 'MCP Server (use assistant tools from Claude Code, Gemini CLI, etc.)',
        checked: true,
      },
    ],
  });

  // ── Write .env ──
  const lines = [
    `# Bootstrap Configuration (generated by setup wizard)`,
    `# ${new Date().toISOString()}`,
    `#`,
    `# All other settings (LLM, channels, workspace, etc.) are configured`,
    `# via the web UI at http://localhost:3007/setup`,
    ``,
    `# Storage mode: 'embedded' or 'external'`,
    `STORAGE_MODE=${storageMode}`,
    ``,
  ];

  if (storageMode === 'external') {
    lines.push(
      `# Database (external mode)`,
      `DATABASE_URL=${databaseUrl}`,
      `REDIS_URL=${redisUrl}`,
      ``,
    );
  } else {
    lines.push(
      `# Data directory (embedded mode)`,
      `DATA_DIR=${dataDir}`,
      ``,
    );
  }

  lines.push(
    `# Security (auto-generated, do not share)`,
    `MASTER_KEY=${masterKey}`,
    `JWT_SECRET=${jwtSecret}`,
    `SESSION_SECRET=${sessionSecret}`,
    ``,
    `# API Server`,
    `PORT=${port}`,
    `HOST=${host}`,
    `CORS_ORIGINS=http://localhost:3007`,
    ``,
  );

  await Bun.write('.env', lines.join('\n'));
  console.log('\n\x1b[32m✅ Bootstrap .env created\x1b[0m');

  // ── Install extras ──
  if (extras.length > 0) {
    console.log('\n\x1b[1m── Installing extras ──\x1b[0m');
    for (const extra of extras) {
      switch (extra) {
        case 'playwright': {
          console.log('Installing Playwright (chromium)...');
          const proc = Bun.spawn(['bunx', 'playwright', 'install', 'chromium'], {
            stdout: 'inherit',
            stderr: 'inherit',
          });
          const code = await proc.exited;
          if (code === 0) console.log('\x1b[32m✓ Playwright installed\x1b[0m');
          else console.log('\x1b[33m⚠ Playwright install exited with code ' + code + '\x1b[0m');
          break;
        }
        case 'ollama': {
          console.log('To install Ollama, run:');
          console.log('  curl -fsSL https://ollama.com/install.sh | sh');
          console.log('Then start it with: ollama serve');
          break;
        }
        case 'browser-ext': {
          const extSrc = import.meta.dir + '/../browser-extension';
          const extDest = homedir() + '/.assistant/browser-extension';
          console.log('Installing browser extension...');
          try {
            const { mkdirSync, cpSync } = await import('fs');
            mkdirSync(extDest, { recursive: true });
            cpSync(extSrc, extDest, { recursive: true });
            console.log('\x1b[32m✓ Browser extension copied to ' + extDest + '\x1b[0m');
            console.log('\n  To load the extension in Chromium:');
            console.log('  1. Open \x1b[36mchromium://extensions\x1b[0m');
            console.log('  2. Enable "Developer mode" (top right)');
            console.log('  3. Click "Load unpacked" and select:');
            console.log(`     \x1b[36m${extDest}\x1b[0m`);
            console.log('  4. Click the extension icon and enter your API key\n');
          } catch (err) {
            console.log('\x1b[33m⚠ Failed to copy browser extension: ' + (err as Error).message + '\x1b[0m');
          }
          break;
        }
        case 'mcp': {
          const mcpDir = import.meta.dir + '/../mcp-server';
          console.log('Building MCP server...');
          const installProc = Bun.spawn(['npm', 'install'], {
            cwd: mcpDir,
            stdout: 'inherit',
            stderr: 'inherit',
          });
          if (await installProc.exited !== 0) {
            console.log('\x1b[33m⚠ MCP server npm install failed\x1b[0m');
            break;
          }
          const buildProc = Bun.spawn(['npm', 'run', 'build'], {
            cwd: mcpDir,
            stdout: 'inherit',
            stderr: 'inherit',
          });
          if (await buildProc.exited !== 0) {
            console.log('\x1b[33m⚠ MCP server build failed\x1b[0m');
            break;
          }
          console.log('\x1b[32m✓ MCP server built\x1b[0m');

          // Generate .mcp.json for Claude Code / Gemini CLI
          const mcpDistPath = mcpDir + '/dist/index.js';
          const mcpConfig = {
            mcpServers: {
              assistant: {
                command: 'node',
                args: [mcpDistPath],
                env: {
                  ASSISTANT_URL: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
                  ASSISTANT_API_KEY: masterKey,
                },
              },
            },
          };
          const mcpJsonPath = import.meta.dir + '/../.mcp.json';
          await Bun.write(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n');
          console.log('\x1b[32m✓ .mcp.json generated\x1b[0m');
          console.log(`\n  MCP server is ready. To use with Claude Code:`);
          console.log(`  - The .mcp.json in the project root is auto-detected`);
          console.log(`  - Or copy it to your home directory: cp .mcp.json ~/.mcp.json\n`);
          break;
        }
      }
    }
  }

  // ── Run migrations ──
  const runMigrate = await confirm({ message: 'Run database migrations now?', default: true });
  if (runMigrate) {
    console.log('\nRunning migrations...');
    // Re-exec via bun so .env is loaded
    const proc = Bun.spawn(['bun', 'run', 'scripts/migrate.ts'], {
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, STORAGE_MODE: storageMode, ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}), ...(dataDir !== '~/.assistant/data' ? { DATA_DIR: dataDir } : {}) },
    });
    const code = await proc.exited;
    if (code === 0) console.log('\x1b[32m✓ Migrations complete\x1b[0m');
    else console.log('\x1b[33m⚠ Migration exited with code ' + code + '\x1b[0m');
  }

  // ── Summary ──
  console.log(`
\x1b[36m╔═══════════════════════════════════════════════════════════╗
║                    SETUP COMPLETE                         ║
╚═══════════════════════════════════════════════════════════╝\x1b[0m

  Mode:     ${storageMode === 'embedded' ? 'Embedded (PGlite + in-memory)' : 'External (PostgreSQL + Redis)'}
  API:      http://${host === '0.0.0.0' ? 'localhost' : host}:${port}
  ${storageMode === 'embedded' ? `Data dir: ${dataDir}` : `Database: ${databaseUrl.replace(/:[^:@]*@/, ':***@')}`}

Next steps:
  1. Start the assistant:  assistant start --dev
  2. Open http://localhost:3007 and register your admin account
  3. Configure LLM providers, channels, etc. via the web UI
`);
}

main().catch((error) => {
  console.error('Setup failed:', error);
  process.exit(1);
});
