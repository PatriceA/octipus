import { spawn } from 'child_process';
import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest } from '@/core/types';

export class GitTool extends BaseTool {
  readonly id = 'git';
  readonly name = 'Git';
  readonly version = '1.0.0';
  readonly description = 'Git version control operations';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'Read git repository status, commit history, diffs, and branch info', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Stage files, create commits, switch branches, stash changes, reset HEAD, and clone repositories', defaultLevel: 'ASK' },
        { action: 'push', description: 'Push local commits to remote repositories (e.g. GitHub, GitLab)', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'status',
      'Get git repository status',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
      }),
      async (args) => {
        const result = await this.git(['status', '--porcelain', '-b'], args.path as string);
        return this.parseStatus(result);
      },
      { permissionAction: 'read' }
    );

    this.registerTool(
      'log',
      'Get git commit history',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        count: { type: 'number', description: 'Number of commits', default: 10 },
        oneline: { type: 'boolean', description: 'One line format', default: false },
      }),
      async (args) => {
        const format = args.oneline ? '--oneline' : '--format=%H|%an|%ae|%at|%s';
        const result = await this.git(['log', `-${args.count || 10}`, format], args.path as string);

        if (args.oneline) {
          return result.split('\n').filter(Boolean);
        }

        return result.split('\n').filter(Boolean).map((line) => {
          const [hash, author, email, timestamp, subject] = line.split('|');
          return { hash, author, email, date: new Date(parseInt(timestamp) * 1000).toISOString(), subject };
        });
      },
      { permissionAction: 'read' }
    );

    this.registerTool(
      'diff',
      'Show file differences',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        file: { type: 'string', description: 'Specific file to diff' },
        staged: { type: 'boolean', description: 'Show staged changes', default: false },
      }),
      async (args) => {
        const gitArgs = ['diff'];
        if (args.staged) gitArgs.push('--staged');
        if (args.file) gitArgs.push(args.file as string);

        return this.git(gitArgs, args.path as string);
      },
      { permissionAction: 'read' }
    );

    this.registerTool(
      'add',
      'Stage files for commit',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        files: { type: 'string', description: 'Files to stage (space-separated or ".")', required: true },
      }),
      async (args) => {
        const files = (args.files as string).split(' ').filter(Boolean);
        await this.git(['add', ...files], args.path as string);
        return { staged: files };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'commit',
      'Create a commit',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        message: { type: 'string', description: 'Commit message', required: true },
      }),
      async (args) => {
        const result = await this.git(['commit', '-m', args.message as string], args.path as string);
        return { success: true, output: result };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'branch',
      'List or create branches',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        name: { type: 'string', description: 'New branch name (if creating)' },
        checkout: { type: 'boolean', description: 'Checkout new branch', default: false },
      }),
      async (args) => {
        if (args.name) {
          const gitArgs = args.checkout ? ['checkout', '-b', args.name as string] : ['branch', args.name as string];
          await this.git(gitArgs, args.path as string);
          return { created: args.name, checkedOut: args.checkout };
        }

        const result = await this.git(['branch', '-a'], args.path as string);
        return result.split('\n').filter(Boolean).map((b) => ({
          name: b.replace(/^\*?\s+/, ''),
          current: b.startsWith('*'),
        }));
      },
      { permissionAction: 'read' }
    );

    this.registerTool(
      'checkout',
      'Switch branches or restore files',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        target: { type: 'string', description: 'Branch name or commit hash', required: true },
      }),
      async (args) => {
        await this.git(['checkout', args.target as string], args.path as string);
        return { checkedOut: args.target };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'pull',
      'Pull changes from remote',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        remote: { type: 'string', description: 'Remote name', default: 'origin' },
        branch: { type: 'string', description: 'Branch name' },
      }),
      async (args) => {
        const gitArgs = ['pull', args.remote as string];
        if (args.branch) gitArgs.push(args.branch as string);

        const result = await this.git(gitArgs, args.path as string);
        return { success: true, output: result };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'push',
      'Push changes to remote',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        remote: { type: 'string', description: 'Remote name', default: 'origin' },
        branch: { type: 'string', description: 'Branch name' },
        setUpstream: { type: 'boolean', description: 'Set upstream', default: false },
      }),
      async (args) => {
        const gitArgs = ['push'];
        if (args.setUpstream) gitArgs.push('-u');
        gitArgs.push(args.remote as string);
        if (args.branch) gitArgs.push(args.branch as string);

        const result = await this.git(gitArgs, args.path as string);
        return { success: true, output: result };
      },
      { permissionAction: 'push' }
    );

    this.registerTool(
      'stash',
      'Stash changes',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        action: { type: 'string', description: 'Action: save, pop, list, drop', default: 'save', enum: ['save', 'pop', 'list', 'drop'] },
        message: { type: 'string', description: 'Stash message (for save)' },
      }),
      async (args) => {
        const gitArgs = ['stash'];
        const action = args.action as string || 'save';

        if (action === 'save' && args.message) {
          gitArgs.push('push', '-m', args.message as string);
        } else {
          gitArgs.push(action);
        }

        const result = await this.git(gitArgs, args.path as string);
        return { action, output: result };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'reset',
      'Reset current HEAD to specified state',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        mode: { type: 'string', description: 'Reset mode', default: 'mixed', enum: ['soft', 'mixed', 'hard'] },
        target: { type: 'string', description: 'Commit to reset to', default: 'HEAD' },
      }),
      async (args) => {
        const gitArgs = ['reset', `--${args.mode || 'mixed'}`, args.target as string || 'HEAD'];
        const result = await this.git(gitArgs, args.path as string);
        return { mode: args.mode, target: args.target, output: result };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'clone',
      'Clone a repository',
      createParameterSchema({
        url: { type: 'string', description: 'Repository URL', required: true },
        path: { type: 'string', description: 'Destination path' },
        depth: { type: 'number', description: 'Shallow clone depth' },
      }),
      async (args) => {
        const gitArgs = ['clone'];
        if (args.depth) gitArgs.push('--depth', String(args.depth));
        gitArgs.push(args.url as string);
        if (args.path) gitArgs.push(args.path as string);

        const result = await this.git(gitArgs, '.');
        return { cloned: args.url, path: args.path || (args.url as string).split('/').pop()?.replace('.git', '') };
      },
      { permissionAction: 'write' }
    );
  }

  private async git(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `Git command failed with code ${code}`));
        }
      });
    });
  }

  private parseStatus(output: string): {
    branch: string;
    ahead?: number;
    behind?: number;
    staged: string[];
    modified: string[];
    untracked: string[];
  } {
    const lines = output.split('\n').filter(Boolean);
    const result = {
      branch: '',
      staged: [] as string[],
      modified: [] as string[],
      untracked: [] as string[],
    };

    for (const line of lines) {
      if (line.startsWith('##')) {
        const match = line.match(/## ([^\s.]+)(?:\.\.\.(\S+?)(?:\s+\[ahead (\d+)(?:, behind (\d+))?\])?)?\s*$/);
        if (match) {
          result.branch = match[1];
          if (match[3]) (result as any).ahead = parseInt(match[3]);
          if (match[4]) (result as any).behind = parseInt(match[4]);
        }
      } else {
        const status = line.substring(0, 2);
        const file = line.substring(3);

        if (status[0] !== ' ' && status[0] !== '?') result.staged.push(file);
        if (status[1] === 'M') result.modified.push(file);
        if (status === '??') result.untracked.push(file);
      }
    }

    return result;
  }
}

export const gitTool = new GitTool();
