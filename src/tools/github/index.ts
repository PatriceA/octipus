import type { ToolManifest } from '@/core/types';
import { runGh } from '@/utils/gh';
import { BaseTool, createParameterSchema, type ToolAvailability } from '../base-tool';

/**
 * Build a validated `repos/<owner>/<name>/contents/<path>` gh-api endpoint.
 * `repo` and `path` are model-provided and interpolated into the endpoint, so
 * they are strictly validated: without this, a `path` like `../../user/repos`
 * would let the tool read arbitrary GitHub API endpoints under the host's gh
 * token. Path segments are percent-encoded and `.`/`..`/empty segments rejected.
 */
export function buildContentsEndpoint(repo: string, path: string, ref?: string): string {
  assertRepoRef(repo);
  const segments = path.replace(/^\/+/, '').split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Invalid file path '${path}'`);
  }
  const safePath = segments.map(encodeURIComponent).join('/');
  return `repos/${repo}/contents/${safePath}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
}

/**
 * `owner/name`, nothing else. Every `gh api repos/<repo>/…` endpoint below
 * interpolates the model-supplied repo, so a value with a slash too many or a
 * `..` would read a different endpoint under the host's token.
 */
export function assertRepoRef(repo: string): asserts repo is string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid repo '${repo}' — expected owner/name`);
  }
}

/** A positive integer for an issue, PR, run or job id — the only shape gh accepts. */
export function assertNumber(value: unknown, what: string): string {
  // `parseInt` would read "7; rm" as 7 — the whole string has to be digits.
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${what} '${String(value)}' — expected a positive integer`);
  return String(n);
}

/**
 * The last `lines` lines of a log. CI logs run to megabytes and the failure
 * is at the end; the head is checkout and install noise nobody asked for.
 */
export function tailLines(text: string, lines: number): { log: string; totalLines: number; truncated: boolean } {
  const all = text.replace(/\r\n?/g, '\n').split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const keep = Math.max(1, Math.trunc(lines));
  const truncated = all.length > keep;
  return { log: (truncated ? all.slice(-keep) : all).join('\n'), totalLines: all.length, truncated };
}

/** Cap a diff so one PR cannot fill the context window on its own. */
export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n… [truncated: ${text.length - maxChars} more characters]`, truncated: true };
}

/** What `pr_review_threads` returns for one thread: the shape the coding role acts on. */
export interface ReviewThreadSummary {
  /** GraphQL node id — what `pr_resolve_thread` takes. */
  id: string;
  path: string | null;
  line: number | null;
  startLine: number | null;
  side: string | null;
  resolved: boolean;
  outdated: boolean;
  comments: { id: number | null; author: string | null; body: string; createdAt: string | null; url: string | null }[];
}

interface ReviewThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<{
            id: string;
            isResolved: boolean;
            isOutdated: boolean;
            path?: string | null;
            line?: number | null;
            startLine?: number | null;
            diffSide?: string | null;
            comments?: { nodes?: Array<{ databaseId?: number | null; author?: { login?: string } | null; body: string; createdAt?: string; url?: string }> };
          }>;
        };
      };
    };
  };
}

/** Flatten the GraphQL shape into threads; open ones only unless asked. */
export function summarizeReviewThreads(response: ReviewThreadsResponse, opts: { includeResolved?: boolean } = {}): ReviewThreadSummary[] {
  const nodes = response.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes
    .filter((t) => opts.includeResolved || !t.isResolved)
    .map((t) => ({
      id: t.id,
      path: t.path ?? null,
      line: t.line ?? null,
      startLine: t.startLine ?? null,
      side: t.diffSide ?? null,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      comments: (t.comments?.nodes ?? []).map((c) => ({
        id: c.databaseId ?? null,
        author: c.author?.login ?? null,
        body: c.body,
        createdAt: c.createdAt ?? null,
        url: c.url ?? null,
      })),
    }));
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line startLine diffSide
          comments(first: 50) { nodes { databaseId author { login } body createdAt url } }
        }
      }
    }
  }
}`;

const DIFF_MAX_CHARS = 200_000;
const LOG_DEFAULT_LINES = 200;
const LOG_MAX_LINES = 2000;

/** Whether a file-content URL points at a GitHub-owned host (SSRF guard). */
export function isAllowedGitHubHost(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname;
    return host === 'api.github.com' || host === 'github.com' || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

export class GitHubTool extends BaseTool {
  readonly id = 'github';
  readonly name = 'GitHub';
  readonly version = '1.0.0';
  readonly description = 'GitHub repository, issue, PR, and workflow management via gh CLI';

  override async checkAvailability(): Promise<ToolAvailability> {
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

    this.registerTool('get_file', "Read a file's contents from a GitHub repo at an optional ref (branch, tag, or commit SHA). Use this to review files like DESIGN.md or src/index.ts without cloning.", createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      path: { type: 'string', description: 'File path within the repo, e.g. DESIGN.md or src/core/index.ts', required: true },
      ref: { type: 'string', description: 'Branch, tag, or commit SHA. Defaults to the repo default branch.' },
    }), async (args) => {
      const repo = args.repo as string;
      const rawPath = (args.path as string).replace(/^\/+/, '');
      const ref = args.ref as string | undefined;
      const endpoint = buildContentsEndpoint(repo, args.path as string, ref);
      const data = JSON.parse(await this.gh(['api', endpoint])) as {
        type?: string; content?: string; encoding?: string; size?: number; download_url?: string;
      };
      if (data.type && data.type !== 'file') {
        throw new Error(`'${rawPath}' is a ${data.type}, not a file`);
      }
      let content: string;
      if (data.content && data.encoding === 'base64') {
        content = Buffer.from(data.content, 'base64').toString('utf-8');
      } else if (data.download_url) {
        // Files over ~1MB omit inline content; fetch the raw blob — but only
        // from GitHub's own hosts (the URL comes from the API response; guard
        // against a crafted/redirected value pointing elsewhere).
        if (!isAllowedGitHubHost(data.download_url)) {
          throw new Error('Refusing to fetch file content from a non-GitHub host');
        }
        content = await this.gh(['api', data.download_url]);
      } else {
        throw new Error(`No readable content returned for '${rawPath}'`);
      }
      return { repo, path: rawPath, ref: ref ?? null, size: data.size ?? content.length, content };
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

    // === The review loop: what a reviewer left, where CI broke, what to fix ===
    this.registerTool('pr_diff', 'Read a pull request\'s diff (unified), or only the list of changed files. Capped at 200k characters — ask for files_only first on a large PR, then get_file for the ones that matter.', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'PR number', required: true },
      files_only: { type: 'boolean', description: 'Only list changed file paths', default: false },
    }), async (args) => {
      const ghArgs = ['pr', 'diff', assertNumber(args.number, 'PR number'), '-R', args.repo as string];
      if (args.files_only) ghArgs.push('--name-only');
      const out = await this.gh(ghArgs);
      if (args.files_only) return { files: out.split('\n').filter(Boolean) };
      const capped = capText(out, DIFF_MAX_CHARS);
      return { diff: capped.text, truncated: capped.truncated };
    }, { permissionAction: 'read' });

    this.registerTool('pr_review_threads', 'List the review threads on a pull request — each with its file, line, resolved state and the comments in it. Open threads only unless include_resolved is set. This is what a reviewer is waiting on; answer or fix each, then pr_resolve_thread.', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'PR number', required: true },
      include_resolved: { type: 'boolean', description: 'Also return resolved threads', default: false },
    }), async (args) => {
      const repo = args.repo as string;
      assertRepoRef(repo);
      const [owner, name] = repo.split('/');
      const raw = await this.gh([
        'api', 'graphql',
        '-f', `query=${REVIEW_THREADS_QUERY}`,
        '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${assertNumber(args.number, 'PR number')}`,
      ]);
      const threads = summarizeReviewThreads(JSON.parse(raw), { includeResolved: Boolean(args.include_resolved) });
      return { count: threads.length, threads };
    }, { permissionAction: 'read' });

    this.registerTool('pr_review_comment', 'Leave a line-level review comment on a pull request, or reply inside an existing thread (reply_to = a comment id from pr_review_threads). A new comment needs path and line; it lands on the PR\'s current head commit.', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'PR number', required: true },
      body: { type: 'string', description: 'Comment body', required: true },
      path: { type: 'string', description: 'File path in the diff (new comment)' },
      line: { type: 'number', description: 'Line number in the file (new comment)' },
      side: { type: 'string', description: 'Which side of the diff the line is on', enum: ['RIGHT', 'LEFT'], default: 'RIGHT' },
      reply_to: { type: 'number', description: 'Id of the review comment to reply to (from pr_review_threads)' },
    }), async (args) => {
      const repo = args.repo as string;
      assertRepoRef(repo);
      const number = assertNumber(args.number, 'PR number');
      const body = String(args.body ?? '');
      if (!body.trim()) throw new Error('Comment body is empty');
      if (args.reply_to !== undefined && args.reply_to !== null && args.reply_to !== '') {
        const replyTo = assertNumber(args.reply_to, 'reply_to comment id');
        const raw = await this.gh(['api', `repos/${repo}/pulls/${number}/comments/${replyTo}/replies`, '-f', `body=${body}`]);
        const created = JSON.parse(raw) as { id?: number; html_url?: string };
        return { replied: true, id: created.id ?? null, url: created.html_url ?? null };
      }
      const path = String(args.path ?? '').replace(/^\/+/, '');
      if (!path) throw new Error('A new review comment needs a path (or reply_to to answer a thread)');
      const line = assertNumber(args.line, 'line');
      const head = JSON.parse(await this.gh(['pr', 'view', number, '-R', repo, '--json', 'headRefOid'])) as { headRefOid?: string };
      if (!head.headRefOid) throw new Error('Could not resolve the PR head commit');
      const raw = await this.gh([
        'api', `repos/${repo}/pulls/${number}/comments`,
        '-f', `body=${body}`, '-f', `path=${path}`, '-F', `line=${line}`,
        '-f', `side=${args.side === 'LEFT' ? 'LEFT' : 'RIGHT'}`, '-f', `commit_id=${head.headRefOid}`,
      ]);
      const created = JSON.parse(raw) as { id?: number; html_url?: string };
      return { created: true, id: created.id ?? null, url: created.html_url ?? null };
    }, { permissionAction: 'write' });

    this.registerTool('pr_resolve_thread', 'Resolve (or reopen) a review thread once it has been addressed. thread_id comes from pr_review_threads.', createParameterSchema({
      thread_id: { type: 'string', description: 'Review thread id (from pr_review_threads)', required: true },
      resolve: { type: 'boolean', description: 'true to resolve, false to reopen', default: true },
    }), async (args) => {
      const threadId = String(args.thread_id ?? '').trim();
      if (!/^[A-Za-z0-9_=-]+$/.test(threadId)) throw new Error('Invalid thread_id');
      const resolve = args.resolve !== false;
      const mutation = resolve
        ? 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }'
        : 'mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }';
      const raw = await this.gh(['api', 'graphql', '-f', `query=${mutation}`, '-F', `id=${threadId}`]);
      const data = JSON.parse(raw) as { data?: Record<string, { thread?: { isResolved?: boolean } }> };
      const thread = data.data?.[resolve ? 'resolveReviewThread' : 'unresolveReviewThread']?.thread;
      return { threadId, resolved: thread?.isResolved ?? resolve };
    }, { permissionAction: 'write' });

    this.registerTool('pr_checks', 'The checks on a pull request\'s head commit — name, state (pass/fail/pending), workflow and a link. Works while checks are still running.', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'PR number', required: true },
    }), async (args) => {
      // Exit 8 = checks pending, 1 = a check failed; both still print the JSON.
      const raw = await runGh(
        ['pr', 'checks', assertNumber(args.number, 'PR number'), '-R', args.repo as string, '--json', 'name,state,bucket,workflow,link,description,startedAt,completedAt'],
        { acceptExitCodes: [1, 8] },
      );
      const checks = JSON.parse(raw.trim() || '[]') as Array<{ bucket?: string }>;
      const counts: Record<string, number> = {};
      for (const c of checks) counts[c.bucket ?? 'unknown'] = (counts[c.bucket ?? 'unknown'] ?? 0) + 1;
      return { counts, checks };
    }, { permissionAction: 'read' });

    this.registerTool('job_log', 'The log of a workflow run or one of its jobs — the LAST lines, where the failure is. Give job_id for one job (from run_view), or run_id for the failed steps of a whole run.', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      run_id: { type: 'string', description: 'Workflow run id' },
      job_id: { type: 'string', description: 'Job id within a run' },
      failed_only: { type: 'boolean', description: 'Only failed steps (default true for a run, false for a job)' },
      lines: { type: 'number', description: 'How many trailing lines to return (default 200, max 2000)' },
    }), async (args) => {
      const repo = args.repo as string;
      const lines = Math.min(LOG_MAX_LINES, Math.max(1, Math.trunc(Number(args.lines) || LOG_DEFAULT_LINES)));
      const ghArgs = ['run', 'view'];
      let failedOnly: boolean;
      if (args.job_id) {
        ghArgs.push('--job', assertNumber(args.job_id, 'job id'));
        failedOnly = args.failed_only === true;
      } else if (args.run_id) {
        ghArgs.push(assertNumber(args.run_id, 'run id'));
        failedOnly = args.failed_only !== false;
      } else {
        throw new Error('Give run_id or job_id');
      }
      ghArgs.push('-R', repo, failedOnly ? '--log-failed' : '--log');
      const tail = tailLines(await this.gh(ghArgs), lines);
      return { failedOnly, ...tail };
    }, { permissionAction: 'read' });

    // === Labels and milestones ===
    this.registerTool('label_list', 'List the labels a repository defines', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
    }), async (args) => {
      return JSON.parse(await this.gh(['label', 'list', '-R', args.repo as string, '--json', 'name,color,description', '--limit', '100']));
    }, { permissionAction: 'read' });

    this.registerTool('set_labels', 'Add and/or remove labels on an issue or pull request', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'Issue or PR number', required: true },
      kind: { type: 'string', description: 'What the number refers to', enum: ['issue', 'pr'], default: 'issue' },
      add: { type: 'string', description: 'Comma-separated labels to add' },
      remove: { type: 'string', description: 'Comma-separated labels to remove' },
    }), async (args) => {
      const add = splitList(args.add);
      const remove = splitList(args.remove);
      if (add.length === 0 && remove.length === 0) throw new Error('Nothing to change — give add and/or remove');
      const ghArgs = [args.kind === 'pr' ? 'pr' : 'issue', 'edit', assertNumber(args.number, 'number'), '-R', args.repo as string];
      for (const l of add) ghArgs.push('--add-label', l);
      for (const l of remove) ghArgs.push('--remove-label', l);
      return { output: await this.gh(ghArgs), added: add, removed: remove };
    }, { permissionAction: 'write' });

    this.registerTool('milestone_list', 'List a repository\'s milestones', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      state: { type: 'string', description: 'Milestone state', enum: ['open', 'closed', 'all'], default: 'open' },
    }), async (args) => {
      const repo = args.repo as string;
      assertRepoRef(repo);
      const state = ['open', 'closed', 'all'].includes(String(args.state)) ? String(args.state) : 'open';
      const raw = JSON.parse(await this.gh(['api', `repos/${repo}/milestones?state=${state}&per_page=100`])) as Array<{
        number: number; title: string; state: string; description?: string | null; due_on?: string | null; open_issues?: number; closed_issues?: number;
      }>;
      return raw.map((m) => ({ number: m.number, title: m.title, state: m.state, description: m.description ?? null, dueOn: m.due_on ?? null, openIssues: m.open_issues ?? 0, closedIssues: m.closed_issues ?? 0 }));
    }, { permissionAction: 'read' });

    this.registerTool('set_milestone', 'Put an issue or pull request on a milestone (by title), or take it off one', createParameterSchema({
      repo: { type: 'string', description: 'Repository (owner/name)', required: true },
      number: { type: 'number', description: 'Issue or PR number', required: true },
      kind: { type: 'string', description: 'What the number refers to', enum: ['issue', 'pr'], default: 'issue' },
      milestone: { type: 'string', description: 'Milestone title; empty string removes the milestone' },
    }), async (args) => {
      const title = String(args.milestone ?? '').trim();
      const ghArgs = [args.kind === 'pr' ? 'pr' : 'issue', 'edit', assertNumber(args.number, 'number'), '-R', args.repo as string];
      if (title) ghArgs.push('--milestone', title);
      else ghArgs.push('--remove-milestone');
      return { output: await this.gh(ghArgs), milestone: title || null };
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
    return (await runGh(args)).trim();
  }
}

/** "a, b,,c" → ["a", "b", "c"]. */
function splitList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

export const githubTool = new GitHubTool();
