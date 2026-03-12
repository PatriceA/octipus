import { spawn } from 'child_process';
import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest } from '@/core/types';

export class GitLabTool extends BaseTool {
  readonly id = 'gitlab';
  readonly name = 'GitLab';
  readonly version = '1.0.0';
  readonly description = 'GitLab project, issue, merge request, and CI/CD management via glab CLI';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'List and view GitLab projects, issues, merge requests, and CI/CD pipelines via glab CLI', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Create new GitLab issues, merge requests, and comments via glab CLI', defaultLevel: 'ASK' },
        { action: 'manage', description: 'Merge merge requests, close issues, and trigger CI/CD pipelines on GitLab', defaultLevel: 'ASK' },
        { action: 'delete', description: 'Permanently delete GitLab projects — irreversible', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [],
    };
  }

  protected async registerTools(): Promise<void> {
    // === Projects ===
    this.registerTool('project_list', 'List GitLab projects', createParameterSchema({
      membership: { type: 'boolean', description: 'Only projects you are a member of', default: true },
      limit: { type: 'number', description: 'Max results', default: 30 },
    }), async (args) => {
      const glabArgs = ['repo', 'list'];
      if (args.membership) glabArgs.push('--member');
      glabArgs.push('--per-page', String(args.limit || 30), '--output', 'json');
      return JSON.parse(await this.glab(glabArgs));
    }, { permissionAction: 'read' });

    this.registerTool('project_view', 'View project details', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name or ID)', required: true },
    }), async (args) => {
      return JSON.parse(await this.glab(['repo', 'view', args.project as string, '--output', 'json']));
    }, { permissionAction: 'read' });

    this.registerTool('project_create', 'Create a GitLab project', createParameterSchema({
      name: { type: 'string', description: 'Project name', required: true },
      description: { type: 'string', description: 'Project description' },
      visibility: { type: 'string', description: 'Visibility level', enum: ['public', 'private', 'internal'], default: 'private' },
    }), async (args) => {
      const glabArgs = ['repo', 'create', '--name', args.name as string];
      if (args.description) glabArgs.push('--description', args.description as string);
      if (args.visibility) glabArgs.push(`--${args.visibility}`);
      return { output: await this.glab(glabArgs) };
    }, { permissionAction: 'write' });

    // === Issues ===
    this.registerTool('issue_list', 'List GitLab issues', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      state: { type: 'string', description: 'Issue state', enum: ['opened', 'closed', 'all'], default: 'opened' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      assignee: { type: 'string', description: 'Filter by assignee username' },
      limit: { type: 'number', description: 'Max results', default: 30 },
    }), async (args) => {
      const glabArgs = ['issue', 'list', '-R', args.project as string, '--output', 'json'];
      if (args.state && args.state !== 'all') glabArgs.push('--state', args.state as string);
      if (args.labels) glabArgs.push('--label', args.labels as string);
      if (args.assignee) glabArgs.push('--assignee', args.assignee as string);
      glabArgs.push('--per-page', String(args.limit || 30));
      return JSON.parse(await this.glab(glabArgs));
    }, { permissionAction: 'read' });

    this.registerTool('issue_view', 'View issue details', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      number: { type: 'number', description: 'Issue number', required: true },
    }), async (args) => {
      return JSON.parse(await this.glab(['issue', 'view', String(args.number), '-R', args.project as string, '--output', 'json']));
    }, { permissionAction: 'read' });

    this.registerTool('issue_create', 'Create a GitLab issue', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      title: { type: 'string', description: 'Issue title', required: true },
      body: { type: 'string', description: 'Issue description' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      assignees: { type: 'string', description: 'Comma-separated assignee usernames' },
    }), async (args) => {
      const glabArgs = ['issue', 'create', '-R', args.project as string, '--title', args.title as string];
      if (args.body) glabArgs.push('--description', args.body as string);
      if (args.labels) glabArgs.push('--label', args.labels as string);
      if (args.assignees) glabArgs.push('--assignee', args.assignees as string);
      return { output: await this.glab(glabArgs) };
    }, { permissionAction: 'write' });

    this.registerTool('issue_comment', 'Comment on a GitLab issue', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      number: { type: 'number', description: 'Issue number', required: true },
      body: { type: 'string', description: 'Comment body', required: true },
    }), async (args) => {
      return { output: await this.glab(['issue', 'note', String(args.number), '-R', args.project as string, '-m', args.body as string]) };
    }, { permissionAction: 'write' });

    this.registerTool('issue_close', 'Close a GitLab issue', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      number: { type: 'number', description: 'Issue number', required: true },
    }), async (args) => {
      return { output: await this.glab(['issue', 'close', String(args.number), '-R', args.project as string]) };
    }, { permissionAction: 'manage' });

    // === Merge Requests ===
    this.registerTool('mr_list', 'List merge requests', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      state: { type: 'string', description: 'MR state', enum: ['opened', 'closed', 'merged', 'all'], default: 'opened' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      limit: { type: 'number', description: 'Max results', default: 30 },
    }), async (args) => {
      const glabArgs = ['mr', 'list', '-R', args.project as string, '--output', 'json'];
      if (args.state && args.state !== 'all') glabArgs.push('--state', args.state as string);
      if (args.labels) glabArgs.push('--label', args.labels as string);
      glabArgs.push('--per-page', String(args.limit || 30));
      return JSON.parse(await this.glab(glabArgs));
    }, { permissionAction: 'read' });

    this.registerTool('mr_view', 'View merge request details', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      number: { type: 'number', description: 'MR number', required: true },
    }), async (args) => {
      return JSON.parse(await this.glab(['mr', 'view', String(args.number), '-R', args.project as string, '--output', 'json']));
    }, { permissionAction: 'read' });

    this.registerTool('mr_create', 'Create a merge request', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      title: { type: 'string', description: 'MR title', required: true },
      body: { type: 'string', description: 'MR description' },
      source_branch: { type: 'string', description: 'Source branch', required: true },
      target_branch: { type: 'string', description: 'Target branch', default: 'main' },
    }), async (args) => {
      const glabArgs = ['mr', 'create', '-R', args.project as string, '--title', args.title as string,
        '--source-branch', args.source_branch as string, '--target-branch', (args.target_branch || 'main') as string];
      if (args.body) glabArgs.push('--description', args.body as string);
      glabArgs.push('--yes');
      return { output: await this.glab(glabArgs) };
    }, { permissionAction: 'write' });

    this.registerTool('mr_comment', 'Comment on a merge request', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      number: { type: 'number', description: 'MR number', required: true },
      body: { type: 'string', description: 'Comment body', required: true },
    }), async (args) => {
      return { output: await this.glab(['mr', 'note', String(args.number), '-R', args.project as string, '-m', args.body as string]) };
    }, { permissionAction: 'write' });

    this.registerTool('mr_merge', 'Merge a merge request', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      number: { type: 'number', description: 'MR number', required: true },
      squash: { type: 'boolean', description: 'Squash commits', default: false },
    }), async (args) => {
      const glabArgs = ['mr', 'merge', String(args.number), '-R', args.project as string, '--yes'];
      if (args.squash) glabArgs.push('--squash');
      return { output: await this.glab(glabArgs) };
    }, { permissionAction: 'manage' });

    this.registerTool('mr_approve', 'Approve a merge request', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      number: { type: 'number', description: 'MR number', required: true },
    }), async (args) => {
      return { output: await this.glab(['mr', 'approve', String(args.number), '-R', args.project as string]) };
    }, { permissionAction: 'manage' });

    // === Pipelines ===
    this.registerTool('pipeline_list', 'List pipelines', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      status: { type: 'string', description: 'Filter by status', enum: ['running', 'pending', 'success', 'failed', 'canceled'] },
      limit: { type: 'number', description: 'Max results', default: 10 },
    }), async (args) => {
      const glabArgs = ['ci', 'list', '-R', args.project as string, '--output', 'json'];
      if (args.status) glabArgs.push('--status', args.status as string);
      glabArgs.push('--per-page', String(args.limit || 10));
      return JSON.parse(await this.glab(glabArgs));
    }, { permissionAction: 'read' });

    this.registerTool('pipeline_view', 'View pipeline details', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      pipeline_id: { type: 'string', description: 'Pipeline ID', required: true },
    }), async (args) => {
      return JSON.parse(await this.glab(['ci', 'view', args.pipeline_id as string, '-R', args.project as string, '--output', 'json']));
    }, { permissionAction: 'read' });

    this.registerTool('pipeline_trigger', 'Trigger a new pipeline', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      ref: { type: 'string', description: 'Branch or tag to run on', default: 'main' },
    }), async (args) => {
      return { output: await this.glab(['ci', 'trigger', '-R', args.project as string, '-b', (args.ref || 'main') as string]) };
    }, { permissionAction: 'manage' });

    this.registerTool('pipeline_cancel', 'Cancel a running pipeline', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      pipeline_id: { type: 'string', description: 'Pipeline ID', required: true },
    }), async (args) => {
      return { output: await this.glab(['ci', 'cancel', args.pipeline_id as string, '-R', args.project as string]) };
    }, { permissionAction: 'manage' });

    this.registerTool('job_list', 'List pipeline jobs', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      pipeline_id: { type: 'string', description: 'Pipeline ID', required: true },
    }), async (args) => {
      return JSON.parse(await this.glab(['ci', 'status', '-R', args.project as string, '-p', args.pipeline_id as string, '--output', 'json']));
    }, { permissionAction: 'read' });

    this.registerTool('job_log', 'View job log output', createParameterSchema({
      project: { type: 'string', description: 'Project (namespace/name)', required: true },
      job_id: { type: 'string', description: 'Job ID', required: true },
    }), async (args) => {
      return { output: await this.glab(['ci', 'trace', args.job_id as string, '-R', args.project as string]) };
    }, { permissionAction: 'read' });
  }

  private async glab(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('glab', args);
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => { stdout += data; });
      child.stderr.on('data', (data: Buffer) => { stderr += data; });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `glab command failed with code ${code}`));
        }
      });
    });
  }
}

export const gitlabTool = new GitLabTool();
