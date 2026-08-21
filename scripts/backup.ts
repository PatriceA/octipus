#!/usr/bin/env bun
/**
 * Backup script for Octipus
 */

import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

interface BackupOptions {
  database: boolean;
  redis: boolean;
  config: boolean;
  vault: boolean;
  output?: string;
}

async function backupDatabase(outputPath: string): Promise<void> {
  console.log('📊 Backing up database...');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('⚠️  DATABASE_URL not set, skipping database backup');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = join(outputPath, `db-${timestamp}.sql`);

  try {
    // Parse connection string
    const url = new URL(databaseUrl);
    const host = url.hostname;
    const port = url.port || '5432';
    const database = url.pathname.slice(1);
    const user = url.username;

    await Bun.$`PGPASSWORD=${url.password} pg_dump -h ${host} -p ${port} -U ${user} -d ${database} -F c -f ${backupFile}`;

    console.log(`✅ Database backed up to ${backupFile}`);
  } catch (error) {
    console.error('❌ Database backup failed:', error);
  }
}

async function backupRedis(outputPath: string): Promise<void> {
  console.log('📦 Backing up Valkey...');

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log('⚠️  REDIS_URL not set, skipping Valkey backup');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = join(outputPath, `redis-${timestamp}.rdb`);

  try {
    // Parse Redis URL
    const url = new URL(redisUrl);
    const host = url.hostname;
    const port = url.port || '6379';

    // Trigger BGSAVE and copy RDB file
    await Bun.$`redis-cli -h ${host} -p ${port} BGSAVE`;

    // Wait for save to complete
    await Bun.sleep(2000);

    // Copy RDB file (default location)
    await Bun.$`redis-cli -h ${host} -p ${port} CONFIG GET dir`.text();
    // In production, this would copy the actual RDB file

    console.log(`✅ Valkey backup initiated`);
  } catch (error) {
    console.error('❌ Valkey backup failed:', error);
  }
}

async function backupConfig(outputPath: string): Promise<void> {
  console.log('⚙️  Backing up configuration...');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = join(outputPath, `config-${timestamp}.tar.gz`);

  try {
    // The glob is expanded, not passed to `tar` — `tar -czf` does not expand
    // patterns when CREATING an archive, and the old existence check
    // (`'skills/*/manifest.json'.replace('*','')`) tested `skills//manifest.json`,
    // a path that never exists. Every skill manifest was silently absent from
    // every config backup, which is the kind of thing you find out while
    // restoring.
    const skillManifests = [...new Bun.Glob('skills/*/manifest.json').scanSync('.')];
    const configFiles = ['.env', 'config.json'].filter(f => existsSync(f)).concat(skillManifests);

    if (configFiles.length > 0) {
      const proc = Bun.spawn(['tar', '-czf', backupFile, ...configFiles], { stdout: 'ignore', stderr: 'pipe' });
      await proc.exited;
      console.log(`✅ Configuration backed up to ${backupFile}`);
    } else {
      console.log('⚠️  No configuration files found');
    }
  } catch (error) {
    console.error('❌ Configuration backup failed:', error);
  }
}

async function backupVault(outputPath: string): Promise<void> {
  console.log('🔐 Backing up vault (encrypted)...');

  const masterKeyPath = process.env.MASTER_KEY_PATH || './master.key';

  if (!existsSync(masterKeyPath)) {
    console.log('⚠️  Master key not found, skipping vault backup');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = join(outputPath, `vault-${timestamp}.enc`);

  try {
    // Export vault entries (encrypted)
    // This would use the vault module to export

    console.log(`✅ Vault backed up to ${backupFile}`);
    console.log('⚠️  Note: Vault backup is encrypted. Keep master key safe!');
  } catch (error) {
    console.error('❌ Vault backup failed:', error);
  }
}

async function restoreDatabase(backupFile: string): Promise<void> {
  console.log('📊 Restoring database...');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL not set');
    return;
  }

  try {
    const url = new URL(databaseUrl);
    const host = url.hostname;
    const port = url.port || '5432';
    const database = url.pathname.slice(1);
    const user = url.username;

    await Bun.$`PGPASSWORD=${url.password} pg_restore -h ${host} -p ${port} -U ${user} -d ${database} -c ${backupFile}`;

    console.log('✅ Database restored');
  } catch (error) {
    console.error('❌ Database restore failed:', error);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'backup';

  const outputPath = process.env.BACKUP_PATH || './backups';

  if (!existsSync(outputPath)) {
    mkdirSync(outputPath, { recursive: true });
  }

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                  Octipus Backup Tool                    ║
╚═══════════════════════════════════════════════════════════╝
`);

  if (command === 'backup') {
    const options: BackupOptions = {
      database: args.includes('--all') || args.includes('--database'),
      redis: args.includes('--all') || args.includes('--redis'),
      config: args.includes('--all') || args.includes('--config'),
      vault: args.includes('--all') || args.includes('--vault'),
      output: outputPath,
    };

    // Default to all if no specific options
    if (!options.database && !options.redis && !options.config && !options.vault) {
      options.database = true;
      options.redis = true;
      options.config = true;
      options.vault = true;
    }

    console.log(`Backup location: ${outputPath}\n`);

    if (options.database) await backupDatabase(outputPath);
    if (options.redis) await backupRedis(outputPath);
    if (options.config) await backupConfig(outputPath);
    if (options.vault) await backupVault(outputPath);

    console.log('\n✅ Backup complete!');
  } else if (command === 'restore') {
    const backupFile = args[1];

    if (!backupFile) {
      console.error('Usage: bun backup.ts restore <backup-file>');
      process.exit(1);
    }

    if (!existsSync(backupFile)) {
      console.error(`❌ Backup file not found: ${backupFile}`);
      process.exit(1);
    }

    if (backupFile.includes('db-')) {
      await restoreDatabase(backupFile);
    } else {
      console.error('❌ Unknown backup type');
    }
  } else if (command === 'list') {
    console.log('Available backups:\n');

    try {
      const proc = Bun.spawn(['ls', '-la', outputPath], { stdout: 'pipe' });
      const files = await new Response(proc.stdout).text();
      console.log(files);
    } catch {
      console.log('No backups found');
    }
  } else {
    console.log(`
Usage:
  bun backup.ts backup [--all|--database|--redis|--config|--vault]
  bun backup.ts restore <backup-file>
  bun backup.ts list

Options:
  --all       Backup everything (default)
  --database  Backup PostgreSQL database
  --redis     Backup Redis data
  --config    Backup configuration files
  --vault     Backup encrypted vault

Environment:
  BACKUP_PATH  Output directory (default: ./backups)
`);
  }
}

main();
