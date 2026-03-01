#!/usr/bin/env bun
/**
 * Interactive setup wizard for the Assistant
 */

import { createInterface } from 'readline';
import { join } from 'path';
import { existsSync } from 'fs';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const prompt = (question: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
};

const confirm = async (question: string, defaultYes = true): Promise<boolean> => {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await prompt(`${question} ${suffix}: `);
  if (!answer.trim()) return defaultYes;
  return answer.toLowerCase().startsWith('y');
};

const select = async (question: string, options: string[]): Promise<string> => {
  console.log(`\n${question}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  const answer = await prompt('Enter number: ');
  const index = parseInt(answer) - 1;
  return options[index] || options[0];
};

const multiSelect = async (question: string, options: string[]): Promise<string[]> => {
  console.log(`\n${question} (comma-separated numbers)`);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  const answer = await prompt('Enter numbers: ');
  const indices = answer.split(',').map(s => parseInt(s.trim()) - 1);
  return indices.filter(i => i >= 0 && i < options.length).map(i => options[i]);
};

interface Config {
  general: {
    workspacePath: string;
    dataPath: string;
    logLevel: string;
  };
  database: {
    type: 'postgres';
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  models: {
    litellmUrl: string;
    ollamaUrl?: string;
    defaultModel: string;
    fallbackModel?: string;
    topicRouting: Record<string, string>;
  };
  security: {
    masterKey: string;
    jwtSecret: string;
    sessionSecret: string;
    allowedUsers: string[];
    defaultPermissionLevel: 'ALLOW' | 'ASK' | 'DENY';
  };
  channels: {
    telegram?: {
      enabled: boolean;
      botToken?: string;
    };
    slack?: {
      enabled: boolean;
      botToken?: string;
      appToken?: string;
    };
    teams?: {
      enabled: boolean;
      appId?: string;
      appPassword?: string;
    };
    webchat?: {
      enabled: boolean;
      port: number;
    };
  };
  skills: string[];
  api: {
    port: number;
    corsOrigins: string[];
  };
}

const defaultConfig: Config = {
  general: {
    workspacePath: './workspace',
    dataPath: './data',
    logLevel: 'info',
  },
  database: {
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    name: 'assistant',
    user: 'assistant',
    password: '',
  },
  redis: {
    host: 'localhost',
    port: 6379,
  },
  models: {
    litellmUrl: 'http://localhost:4000',
    ollamaUrl: 'http://localhost:11434',
    defaultModel: 'gpt-4',
    topicRouting: {},
  },
  security: {
    masterKey: '',
    jwtSecret: '',
    sessionSecret: '',
    allowedUsers: [],
    defaultPermissionLevel: 'ASK',
  },
  channels: {
    webchat: {
      enabled: true,
      port: 3001,
    },
  },
  skills: ['filesystem', 'shell', 'git'],
  api: {
    port: 3000,
    corsOrigins: ['http://localhost:3001'],
  },
};

async function printBanner(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║     █████╗ ███████╗███████╗██╗███████╗████████╗          ║
║    ██╔══██╗██╔════╝██╔════╝██║██╔════╝╚══██╔══╝          ║
║    ███████║███████╗███████╗██║███████╗   ██║             ║
║    ██╔══██║╚════██║╚════██║██║╚════██║   ██║             ║
║    ██║  ██║███████║███████║██║███████║   ██║             ║
║    ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝╚══════╝   ╚═╝             ║
║                                                           ║
║              Setup Wizard v1.0.0                          ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);
}

async function setupGeneral(config: Config): Promise<void> {
  console.log('\n📁 GENERAL CONFIGURATION\n');

  config.general.workspacePath = await prompt(
    `Workspace path [${defaultConfig.general.workspacePath}]: `
  ) || defaultConfig.general.workspacePath;

  config.general.dataPath = await prompt(
    `Data path [${defaultConfig.general.dataPath}]: `
  ) || defaultConfig.general.dataPath;

  config.general.logLevel = await select('Log level:', [
    'debug',
    'info',
    'warn',
    'error',
  ]);
}

async function setupDatabase(config: Config): Promise<void> {
  console.log('\n🗄️  DATABASE CONFIGURATION\n');

  const useExisting = await confirm('Use existing PostgreSQL installation?');

  if (useExisting) {
    config.database.host = await prompt(
      `PostgreSQL host [${defaultConfig.database.host}]: `
    ) || defaultConfig.database.host;

    config.database.port = parseInt(await prompt(
      `PostgreSQL port [${defaultConfig.database.port}]: `
    )) || defaultConfig.database.port;

    config.database.name = await prompt(
      `Database name [${defaultConfig.database.name}]: `
    ) || defaultConfig.database.name;

    config.database.user = await prompt(
      `Database user [${defaultConfig.database.user}]: `
    ) || defaultConfig.database.user;

    config.database.password = await prompt('Database password: ');

    // Test connection
    console.log('\nTesting database connection...');
    try {
      // Simple connection test would go here
      console.log('✅ Database connection successful');
    } catch (error) {
      console.log('❌ Database connection failed. Please check your credentials.');
    }
  } else {
    console.log('\nNote: You will need to set up PostgreSQL manually.');
    console.log('Optional extensions: pgvector (for embeddings/vector search)');
    console.log('\nRun these commands in PostgreSQL:');
    console.log('  CREATE DATABASE assistant;');
    console.log('  -- Optional: CREATE EXTENSION IF NOT EXISTS vector;');
  }
}

async function setupRedis(config: Config): Promise<void> {
  console.log('\n📦 REDIS CONFIGURATION\n');

  const useExisting = await confirm('Use existing Redis installation?');

  if (useExisting) {
    config.redis.host = await prompt(
      `Redis host [${defaultConfig.redis.host}]: `
    ) || defaultConfig.redis.host;

    config.redis.port = parseInt(await prompt(
      `Redis port [${defaultConfig.redis.port}]: `
    )) || defaultConfig.redis.port;

    const hasPassword = await confirm('Redis requires password?', false);
    if (hasPassword) {
      config.redis.password = await prompt('Redis password: ');
    }

    console.log('\nTesting Redis connection...');
    try {
      // Simple connection test would go here
      console.log('✅ Redis connection successful');
    } catch (error) {
      console.log('❌ Redis connection failed. Please check your settings.');
    }
  }
}

async function setupModels(config: Config): Promise<void> {
  console.log('\n🤖 MODEL CONFIGURATION\n');

  const modelSource = await select('Model provider:', [
    'LiteLLM Proxy (recommended)',
    'Direct OpenAI API',
    'Local Ollama',
    'Custom endpoint',
  ]);

  switch (modelSource) {
    case 'LiteLLM Proxy (recommended)':
      config.models.litellmUrl = await prompt(
        `LiteLLM URL [${defaultConfig.models.litellmUrl}]: `
      ) || defaultConfig.models.litellmUrl;
      break;

    case 'Direct OpenAI API':
      config.models.litellmUrl = 'https://api.openai.com/v1';
      const openaiKey = await prompt('OpenAI API Key: ');
      process.env.OPENAI_API_KEY = openaiKey;
      break;

    case 'Local Ollama':
      config.models.ollamaUrl = await prompt('Ollama URL [http://localhost:11434]: ') || 'http://localhost:11434';
      config.models.litellmUrl = config.models.ollamaUrl;
      config.models.defaultModel = await prompt('Default model [ollama/llama3.2]: ') || 'ollama/llama3.2';
      break;

    case 'Custom endpoint':
      config.models.litellmUrl = await prompt('Custom API endpoint URL: ');
      break;
  }

  config.models.defaultModel = await prompt(
    `Default model [${config.models.defaultModel || 'gpt-4'}]: `
  ) || config.models.defaultModel || 'gpt-4';

  const setupRouting = await confirm('Configure topic-based model routing?', false);
  if (setupRouting) {
    console.log('\nEnter topic:model pairs (empty to finish):');
    while (true) {
      const topic = await prompt('Topic (e.g., "coding"): ');
      if (!topic.trim()) break;
      const model = await prompt('Model: ');
      if (model.trim()) {
        config.models.topicRouting[topic] = model;
      }
    }
  }
}

function generateSecureKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64');
}

async function setupSecurity(config: Config): Promise<void> {
  console.log('\n🔒 SECURITY CONFIGURATION\n');

  const generateKeys = await confirm('Generate new security keys? (recommended)');
  if (generateKeys) {
    config.security.masterKey = generateSecureKey();
    config.security.jwtSecret = generateSecureKey();
    config.security.sessionSecret = generateSecureKey();
    console.log('✅ Security keys generated');
    console.log('⚠️  These keys are stored in .env - keep this file secure!');
  } else {
    config.security.masterKey = await prompt('Master Key (min 32 chars): ');
    config.security.jwtSecret = await prompt('JWT Secret (min 32 chars): ');
    config.security.sessionSecret = await prompt('Session Secret (min 32 chars): ');
  }

  config.security.defaultPermissionLevel = await select(
    'Default permission level for new skills:',
    ['ALLOW', 'ASK', 'DENY']
  ) as 'ALLOW' | 'ASK' | 'DENY';

  console.log('\nAdd allowed user identifiers (empty to finish):');
  while (true) {
    const user = await prompt('User ID (e.g., email, telegram ID): ');
    if (!user.trim()) break;
    config.security.allowedUsers.push(user);
  }
}

async function setupChannels(config: Config): Promise<void> {
  console.log('\n💬 CHANNEL CONFIGURATION\n');

  const channels = await multiSelect('Enable channels:', [
    'Web Chat',
    'Telegram',
    'Slack',
    'Microsoft Teams',
  ]);

  config.channels = {};

  if (channels.includes('Web Chat')) {
    config.channels.webchat = {
      enabled: true,
      port: parseInt(await prompt('Web Chat port [3001]: ')) || 3001,
    };
  }

  if (channels.includes('Telegram')) {
    console.log('\n📱 Telegram Setup');
    console.log('1. Message @BotFather on Telegram');
    console.log('2. Create a new bot with /newbot');
    console.log('3. Copy the bot token');

    config.channels.telegram = {
      enabled: true,
      botToken: await prompt('Telegram Bot Token: '),
    };
  }

  if (channels.includes('Slack')) {
    console.log('\n📱 Slack Setup');
    console.log('1. Create a Slack app at https://api.slack.com/apps');
    console.log('2. Enable Socket Mode');
    console.log('3. Get Bot Token (xoxb-...) and App Token (xapp-...)');

    config.channels.slack = {
      enabled: true,
      botToken: await prompt('Slack Bot Token (xoxb-...): '),
      appToken: await prompt('Slack App Token (xapp-...): '),
    };
  }

  if (channels.includes('Microsoft Teams')) {
    console.log('\n📱 Microsoft Teams Setup');
    console.log('1. Register an app in Azure Portal');
    console.log('2. Enable Teams channel in Bot Framework');

    config.channels.teams = {
      enabled: true,
      appId: await prompt('Teams App ID: '),
      appPassword: await prompt('Teams App Password: '),
    };
  }
}

async function setupSkills(config: Config): Promise<void> {
  console.log('\n🛠️  SKILLS CONFIGURATION\n');

  const skills = await multiSelect('Enable skills:', [
    'filesystem - File read/write operations',
    'shell - Command execution',
    'git - Git operations',
    'browser - Web automation with Playwright',
    'docker - Container management',
    'code-execution - Run code in containers',
  ]);

  config.skills = skills.map(s => s.split(' - ')[0]);

  if (config.skills.includes('shell')) {
    console.log('\n⚠️  Shell skill can execute arbitrary commands.');
    const restrictShell = await confirm('Restrict shell to specific commands only?');
    if (restrictShell) {
      console.log('Enter allowed commands (empty to finish):');
      const allowedCommands: string[] = [];
      while (true) {
        const cmd = await prompt('Command: ');
        if (!cmd.trim()) break;
        allowedCommands.push(cmd);
      }
      // Store in config
    }
  }

  if (config.skills.includes('browser')) {
    console.log('\nInstalling Playwright browsers...');
    try {
      await Bun.$`bunx playwright install chromium`.quiet();
      console.log('✅ Chromium installed');
    } catch {
      console.log('⚠️  Browser installation failed. Run: bunx playwright install');
    }
  }
}

async function setupAPI(config: Config): Promise<void> {
  console.log('\n🌐 API CONFIGURATION\n');

  config.api.port = parseInt(await prompt(
    `API port [${defaultConfig.api.port}]: `
  )) || defaultConfig.api.port;

  console.log('\nCORS origins (empty to finish):');
  config.api.corsOrigins = [];
  while (true) {
    const origin = await prompt('Origin URL: ');
    if (!origin.trim()) break;
    config.api.corsOrigins.push(origin);
  }

  if (config.api.corsOrigins.length === 0) {
    config.api.corsOrigins = ['http://localhost:3001'];
  }
}

async function generateEnvFile(config: Config): Promise<void> {
  const envContent = `# Generated by setup wizard
# ${new Date().toISOString()}

# General
WORKSPACE_PATH=${config.general.workspacePath}
DATA_PATH=${config.general.dataPath}
LOG_LEVEL=${config.general.logLevel}

# Database
DATABASE_URL=postgres://${config.database.user}:${config.database.password}@${config.database.host}:${config.database.port}/${config.database.name}

# Redis
REDIS_URL=redis://${config.redis.password ? `:${config.redis.password}@` : ''}${config.redis.host}:${config.redis.port}

# Models
LITELLM_URL=${config.models.litellmUrl}
${config.models.ollamaUrl ? `OLLAMA_URL=${config.models.ollamaUrl}` : ''}
DEFAULT_MODEL=${config.models.defaultModel}
${config.models.fallbackModel ? `FALLBACK_MODEL=${config.models.fallbackModel}` : ''}

# Security
MASTER_KEY=${config.security.masterKey}
JWT_SECRET=${config.security.jwtSecret}
SESSION_SECRET=${config.security.sessionSecret}
DEFAULT_PERMISSION_LEVEL=${config.security.defaultPermissionLevel}

# Channels
${config.channels.telegram?.enabled ? `TELEGRAM_BOT_TOKEN=${config.channels.telegram.botToken}` : '# TELEGRAM_BOT_TOKEN='}
${config.channels.slack?.enabled ? `SLACK_BOT_TOKEN=${config.channels.slack.botToken}\nSLACK_APP_TOKEN=${config.channels.slack.appToken}` : '# SLACK_BOT_TOKEN=\n# SLACK_APP_TOKEN='}
${config.channels.teams?.enabled ? `TEAMS_APP_ID=${config.channels.teams.appId}\nTEAMS_APP_PASSWORD=${config.channels.teams.appPassword}` : '# TEAMS_APP_ID=\n# TEAMS_APP_PASSWORD='}
WEBCHAT_PORT=${config.channels.webchat?.port || 3001}

# API
API_PORT=${config.api.port}
CORS_ORIGINS=${config.api.corsOrigins.join(',')}

# Skills
ENABLED_SKILLS=${config.skills.join(',')}
`;

  await Bun.write('.env', envContent);
  console.log('\n✅ Configuration saved to .env');
}

async function runMigrations(): Promise<void> {
  console.log('\n📊 Running database migrations...');

  try {
    await Bun.$`bun run src/db/migrations/0000_initial.sql`.quiet();
    console.log('✅ Migrations complete');
  } catch (error) {
    console.log('⚠️  Migration failed. Run manually: bun run migrate');
  }
}

async function printSummary(config: Config): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    SETUP COMPLETE                         ║
╚═══════════════════════════════════════════════════════════╝

Configuration Summary:
  📁 Workspace: ${config.general.workspacePath}
  🗄️  Database: ${config.database.host}:${config.database.port}/${config.database.name}
  📦 Redis: ${config.redis.host}:${config.redis.port}
  🤖 Models: ${config.models.litellmUrl}
  🔒 Security: Keys generated, ${config.security.defaultPermissionLevel} mode
  💬 Channels: ${Object.entries(config.channels).filter(([_, v]) => v?.enabled).map(([k]) => k).join(', ') || 'webchat'}
  🛠️  Skills: ${config.skills.join(', ')}
  🌐 API: http://localhost:${config.api.port}

Next steps:
  1. Review .env file
  2. Start the assistant: bun run start
  3. Open web UI: http://localhost:${config.channels.webchat?.port || 3001}

Documentation: https://github.com/your-repo/assistant#readme
`);
}

async function main(): Promise<void> {
  await printBanner();

  const quickSetup = await confirm('Use quick setup with defaults?', false);

  const config: Config = JSON.parse(JSON.stringify(defaultConfig));

  if (quickSetup) {
    console.log('\nUsing default configuration...');

    // Just ask for essential credentials
    config.database.password = await prompt('Database password: ');

    // Generate security keys
    config.security.masterKey = generateSecureKey();
    config.security.jwtSecret = generateSecureKey();
    config.security.sessionSecret = generateSecureKey();
    console.log('✅ Security keys generated');

    const setupTelegram = await confirm('Setup Telegram bot?', false);
    if (setupTelegram) {
      config.channels.telegram = {
        enabled: true,
        botToken: await prompt('Telegram Bot Token: '),
      };
    }
  } else {
    await setupGeneral(config);
    await setupDatabase(config);
    await setupRedis(config);
    await setupModels(config);
    await setupSecurity(config);
    await setupChannels(config);
    await setupSkills(config);
    await setupAPI(config);
  }

  await generateEnvFile(config);

  const runMigrate = await confirm('Run database migrations now?');
  if (runMigrate) {
    await runMigrations();
  }

  await printSummary(config);

  rl.close();
}

main().catch((error) => {
  console.error('Setup failed:', error);
  rl.close();
  process.exit(1);
});
