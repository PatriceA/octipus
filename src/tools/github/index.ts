import { spawn } from 'child_process';
import { BaseTool, createParameterSchema, type ToolAvailability } from '../base-tool';
import type { ToolManifest } from '@/core/types';

export class GitHubTool extends BaseTool {
  readonly id = 'github';
  readonly name = 'GitHub';
  readonly version = '1.0.0';
  readonly description = 'GitHub repository, issue, PR, and workflow management via gh CLI';

  async checkAvailability(): Promise<ToolAvailability> {
    try {
      const { execSync } = await import('child_process');
      execSync('gh auth status', { stdio: 'ignore', timeout: 5000 });
      return { available: true };
    } catch {
      return { available: false, reason: 'GitHub CLI (gh) not installed or not authenticated' };
    }
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'List and view GitHub repos, issues, PRs, releases, and workflow runs via gh CLI', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Create new GitHub issues, pull requests, comments, and releases via gh CLI', defaultLevel: 'ASK' },
        { action: 'manage', description: 'Merge pull requests, close issues, and trigger GitHub Actions workflows', defaultLevel: 'ASK' },
        { action: 'delete', description: 'Permanently delete GitHub repositories or releases — irreversible', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [],
    };
  }

  protected async registerTools(): Promise<void> {
    // === Repos ===
    this.registerTool('repo_list', 'List your GitHub repositories', createParameterSchema({
      limit: { type: 'number', description: 'Max results', default: 30 },
      visibility: { type: 'string', description: 'Filter by visibility', enum: ['public', 'private', 'all'], default: 'all' },
    }), async (args) => {
      const ghArgs = ['repo', 'list', '--json', 'name,owner,description,visibility,updatedAt,url', '--limit', String(args.limit || 30)];
      if (args.visibility && args.visibility !== 'all') ghArgs.push(`--${args.visibility}`);
      return JSON.parse(await this.gh(ghArgs));
    }, { permissionAction: 'read' });

    this.registerTool('repo_view', 'View repository details', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
    }), async (args) => {
      return JSON.parse(await this.gh(['repo', 'view', args.repo as string, '--json', 'name,owner,description,url,defaultBranchRef,stargazerCount,forkCount,issues,pullRequests']));
    }, { permissionAction: 'read' });

    this.registerTool('repo_create', 'Create a new GitHub repository', createParameterSchema({
      name: { type: 'string', description: 'Repository name', required: true },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Make private', default: false },
    }), async (args) => {
      const ghArgs = ['repo', 'create', args.name as string, '--confirm'];
      if (args.description) ghArgs.push('--description', args.description as string);
      ghArgs.push(args.private ? '--private' : '--public');
      return { output: await this.gh(ghArgs) };
    }, { permissionAction: 'write' });

    this.registerTool('repo_clone', 'Clone a GitHub repository', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name or URL)', required: true },
      path: { type: 'string', description: 'Local destination path' },
    }), async (args) => {
      const ghArgs = ['repo', 'clone', args.repo as string];
      if (args.path) ghArgs.push(args.path as string);
      return { output: await this.gh(ghArgs) };
    }, { permissionAction: 'write' });

    this.registerTool('repo_fork', 'Fork a GitHub repository', createParameterSchema({
      repo: { type: 'string', description: 'Repository to fork (owner/name)', required: true },
      org: { type: 'string', description: 'Organization to fork into' },
    }), async (args) => {
      const ghArgs = ['repo', 'fork', args.repo as string, '--clone=false'];
      if (args.org) ghArgs.push('--org', args.org as string);
      return { output: await this.gh(ghArgs) };
    }, { permissionAction: 'write' });

    // === Issues ===
    this.registerTool('issue_list', 'List GitHub issues', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      state: { type: 'string', description: 'Issue state', enum: ['open', 'closed', 'all'], default: 'open' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      assignee: { type: 'string', description: 'Filter by assignee' },
      limit: { type: 'number', description: 'Max results', default: 30 },
    }), async (args) => {
      const ghArgs = ['issue', 'list', '-R', args.repo as string, '--json', 'number,title,state,author,labels,assignees,createdAt,updatedAt'];
      if (args.state) ghArgs.push('--state', args.state as string);
      if (args.labels) ghArgs.push('--label', args.labels as string);
      if (args.assignee) ghArgs.push('--assignee', args.assignee as string);
      ghArgs.push('--limit', String(args.limit || 30));
      return JSON.parse(await this.gh(ghArgs));
    }, { permissionAction: 'read' });

    this.registerTool('issue_view', 'View issue details', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'Issue number', required: true },
    }), async (args) => {
      return JSON.parse(await this.gh(['issue', 'view', String(args.number), '-R', args.repo as string, '--json', 'number,title,state,body,author,labels,assignees,comments,createdAt,updatedAt']));
    }, { permissionAction: 'read' });

    this.registerTool('issue_create', 'Create a GitHub issue', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      title: { type: 'string', description: 'Issue title', required: true },
      body: { type: 'string', description: 'Issue body' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      assignees: { type: 'string', description: 'Comma-separated assignees' },
    }), async (args) => {
      const ghArgs = ['issue', 'create', '-R', args.repo as string, '--title', args.title as string];
      if (args.body) ghArgs.push('--body', args.body as string);
      if (args.labels) ghArgs.push('--label', args.labels as string);
      if (args.assignees) ghArgs.push('--assignee', args.assignees as string);
      return { output: await this.gh(ghArgs) };
    }, { permissionAction: 'write' });

    this.registerTool('issue_comment', 'Comment on a GitHub issue', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'Issue number', required: true },
      body: { type: 'string', description: 'Comment body', required: true },
    }), async (args) => {
      return { output: await this.gh(['issue', 'comment', String(args.number), '-R', args.repo as string, '--body', args.body as string]) };
    }, { permissionAction: 'write' });

    this.registerTool('issue_close', 'Close a GitHub issue', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'Issue number', required: true },
      reason: { type: 'string', description: 'Close reason', enum: ['completed', 'not planned'] },
    }), async (args) => {
      const ghArgs = ['issue', 'close', String(args.number), '-R', args.repo as string];
      if (args.reason) ghArgs.push('--reason', args.reason as string);
      return { output: await this.gh(ghArgs) };
    }, { permissionAction: 'manage' });

    // === Pull Requests ===
    this.registerTool('pr_list', 'List pull requests', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      state: { type: 'string', description: 'PR state', enum: ['open', 'closed', 'merged', 'all'], default: 'open' },
      base: { type: 'string', description: 'Base branch filter' },
      head: { type: 'string', description: 'Head branch filter' },
      limit: { type: 'number', description: 'Max results', default: 30 },
    }), async (args) => {
      const ghArgs = ['pr', 'list', '-R', args.repo as string, '--json', 'number,title,state,author,baseRefName,headRefName,createdAt,updatedAt,mergeable'];
      if (args.state) ghArgs.push('--state', args.state as string);
      if (args.base) ghArgs.push('--base', args.base as string);
      if (args.head) ghArgs.push('--head', args.head as string);
      ghArgs.push('--limit', String(args.limit || 30));
      return JSON.parse(await this.gh(ghArgs));
    }, { permissionAction: 'read' });

    this.registerTool('pr_view', 'View pull request details', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'PR number', required: true },
    }), async (args) => {
      return JSON.parse(await this.gh(['pr', 'view', String(args.number), '-R', args.repo as string, '--json', 'number,title,state,body,author,baseRefName,headRefName,reviews,comments,commits,files,additions,deletions,createdAt,updatedAt,mergeable,mergeStateStatus']));
    }, { permissionAction: 'read' });

    this.registerTool('pr_create', 'Create a pull request', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      title: { type: 'string', description: 'PR title', required: true },
      body: { type: 'string', description: 'PR description' },
      base: { type: 'string', description: 'Base branch' },
      head: { type: 'string', description: 'Head branch' },
      draft: { type: 'boolean', description: 'Create as draft', default: false },
    }), async (args) => {
      const ghArgs = ['pr', 'create', '-R', args.repo as string, '--title', args.title as string];
      if (args.body) ghArgs.push('--body', args.body as string);
      if (args.base) ghArgs.push('--base', args.base as string);
      if (args.head) ghArgs.push('--head', args.head as string);
      if (args.draft) ghArgs.push('--draft');
      return { output: await this.gh(ghArgs) };
    }, { permissionAction: 'write' });

    this.registerTool('pr_review', 'Review a pull request', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'PR number', required: true },
      event: { type: 'string', description: 'Review type', enum: ['approve', 'request-changes', 'comment'], required: true },
      body: { type: 'string', description: 'Review comment' },
    }), async (args) => {
      const ghArgs = ['pr', 'review', String(args.number), '-R', args.repo as string, `--${args.event}`];
      if (args.body) ghArgs.push('--body', args.body as string);
      return { output: await this.gh(ghArgs) };
    }, { permissionAction: 'write' });

    this.registerTool('pr_merge', 'Merge a pull request', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'PR number', required: true },
      method: { type: 'string', description: 'Merge method', enum: ['merge', 'squash', 'rebase'], default: 'merge' },
    }), async (args) => {
      const ghArgs = ['pr', 'merge', String(args.number), '-R', args.repo as string, `--${args.method || 'merge'}`];
      return { output: await this.gh(ghArgs) };
    }, { permissionAction: 'manage' });

    this.registerTool('pr_comment', 'Comment on a pull request', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'PR number', required: true },
      body: { type: 'string', description: 'Comment body', required: true },
    }), async (args) => {
      return { output: await this.gh(['pr', 'comment', String(args.number), '-R', args.repo as string, '--body', args.body as string]) };
    }, { permissionAction: 'write' });

    // === Releases ===
    this.registerTool('release_list', 'List releases', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      limit: { type: 'number', description: 'Max results', default: 10 },
    }), async (args) => {
      return JSON.parse(await this.gh(['release', 'list', '-R', args.repo as string, '--json', 'tagName,name,isDraft,isPrerelease,publishedAt', '--limit', String(args.limit || 10)]));
    }, { permissionAction: 'read' });

    this.registerTool('release_create', 'Create a release', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      tag: { type: 'string', description: 'Tag name', required: true },
      title: { type: 'string', description: 'Release title' },
      notes: { type: 'string', description: 'Release notes' },
      draft: { type: 'boolean', description: 'Create as draft', default: false },
      prerelease: { type: 'boolean', description: 'Mark as prerelease', default: false },
    }), async (args) => {
      const ghArgs = ['release', 'create', args.tag as string, '-R', args.repo as string];
      if (args.title) ghArgs.push('--title', args.title as string);
      if (args.notes) ghArgs.push('--notes', args.notes as string);
      if (args.draft) ghArgs.push('--draft');
      if (args.prerelease) ghArgs.push('--prerelease');
      return { output: await this.gh(ghArgs) };
    }, { permissionAction: 'write' });

    // === Actions / Workflows ===
    this.registerTool('workflow_list', 'List workflows', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
    }), async (args) => {
      return JSON.parse(await this.gh(['workflow', 'list', '-R', args.repo as string, '--json', 'id,name,state']));
    }, { permissionAction: 'read' });

    this.registerTool('run_list', 'List workflow runs', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      workflow: { type: 'string', description: 'Workflow name or ID' },
      limit: { type: 'number', description: 'Max results', default: 10 },
    }), async (args) => {
      const ghArgs = ['run', 'list', '-R', args.repo as string, '--json', 'databaseId,workflowName,status,conclusion,headBranch,event,createdAt'];
      if (args.workflow) ghArgs.push('--workflow', args.workflow as string);
      ghArgs.push('--limit', String(args.limit || 10));
      return JSON.parse(await this.gh(ghArgs));
    }, { permissionAction: 'read' });

    this.registerTool('run_view', 'View workflow run details', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      run_id: { type: 'string', description: 'Run ID', required: true },
    }), async (args) => {
      return JSON.parse(await this.gh(['run', 'view', args.run_id as string, '-R', args.repo as string, '--json', 'databaseId,workflowName,status,conclusion,headBranch,event,jobs,createdAt,updatedAt']));
    }, { permissionAction: 'read' });

    this.registerTool('workflow_run', 'Trigger a workflow', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      workflow: { type: 'string', description: 'Workflow name or filename', required: true },
      ref: { type: 'string', description: 'Branch or tag ref', default: 'main' },
    }), async (args) => {
      return { output: await this.gh(['workflow', 'run', args.workflow as string, '-R', args.repo as string, '--ref', (args.ref || 'main') as string]) };
    }, { permissionAction: 'manage' });
  }

  private async gh(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('gh', args);
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => { stdout += data; });
      child.stderr.on('data', (data: Buffer) => { stderr += data; });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `gh command failed with code ${code}`));
        }
      });
    });
  }
}

export const githubTool = new GitHubTool();
