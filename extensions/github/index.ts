import type { PluginContext, PluginToolContext } from '../../src/plugins/types';

/**
 * GitHub plugin — thin, typed wrapper over the GitHub REST API (v3).
 *
 * Auth: the token is resolved from the VAULT per call (manifest secret
 * `github.token` → user scope first, then system fallback) and arrives in
 * `ctx.config.token`. It is never read from `.env`/`process.env`. Public reads
 * work without a token (rate-limited to 60 req/h); writes and private repos
 * require one. API errors are surfaced loudly with the status + GitHub message.
 */

const API = 'https://api.github.com';

let log: PluginContext['logger'] | undefined;

function tokenOf(ctx?: PluginToolContext): string | undefined {
  const t = ctx?.config.token;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

function buildHeaders(token: string | undefined, json: boolean): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'octipus-github-plugin',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function gh(
  method: string,
  path: string,
  body: unknown,
  token: string | undefined,
): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: buildHeaders(token, body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data
        ? String((data as { message: unknown }).message)
        : res.statusText;
    throw new Error(`GitHub API ${method} ${path} failed (${res.status}): ${message}`);
  }
  return data;
}

/** Build a caller bound to this invocation's token (concurrency-safe per user). */
function api(ctx?: PluginToolContext): (method: string, path: string, body?: unknown) => Promise<unknown> {
  const token = tokenOf(ctx);
  return (method, path, body) => gh(method, path, body, token);
}

// --- argument helpers ------------------------------------------------------

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Missing required string parameter "${key}"`);
  }
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function reqNum(args: Record<string, unknown>, key: string): number {
  const n = Number(args[key]);
  if (!Number.isFinite(n)) {
    throw new Error(`Missing required number parameter "${key}"`);
  }
  return n;
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** Split a comma-separated string parameter into a trimmed, non-empty array. */
function optList(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || v.length === 0) return undefined;
  const items = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Build a query string from defined params (skips undefined/empty). */
function qs(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

function decodeBase64(content: string): string {
  return Buffer.from(content, 'base64').toString('utf-8');
}

// --- plugin ----------------------------------------------------------------

export default {
  name: 'github',

  async initialize(context: PluginContext): Promise<void> {
    log = context.logger;
    log.info('GitHub plugin initialized — token resolved per call from vault secret "github.token"');
  },

  tools: {
    async get_repo(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      return call('GET', `/repos/${reqStr(args, 'owner')}/${reqStr(args, 'repo')}`);
    },

    async list_repos(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const username = optStr(args, 'username');
      const query = qs({
        type: optStr(args, 'type'),
        sort: optStr(args, 'sort'),
        per_page: optNum(args, 'per_page'),
        page: optNum(args, 'page'),
      });
      return call('GET', username ? `/users/${username}/repos${query}` : `/user/repos${query}`);
    },

    async search_repositories(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const query = qs({
        q: reqStr(args, 'query'),
        sort: optStr(args, 'sort'),
        order: optStr(args, 'order'),
        per_page: optNum(args, 'per_page'),
      });
      return call('GET', `/search/repositories${query}`);
    },

    async create_issue(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const owner = reqStr(args, 'owner');
      const repo = reqStr(args, 'repo');
      const body: Record<string, unknown> = { title: reqStr(args, 'title') };
      const issueBody = optStr(args, 'body');
      if (issueBody) body.body = issueBody;
      const labels = optList(args, 'labels');
      if (labels) body.labels = labels;
      const assignees = optList(args, 'assignees');
      if (assignees) body.assignees = assignees;
      return call('POST', `/repos/${owner}/${repo}/issues`, body);
    },

    async list_issues(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const owner = reqStr(args, 'owner');
      const repo = reqStr(args, 'repo');
      const query = qs({
        state: optStr(args, 'state'),
        labels: optStr(args, 'labels'),
        assignee: optStr(args, 'assignee'),
        sort: optStr(args, 'sort'),
        per_page: optNum(args, 'per_page'),
      });
      return call('GET', `/repos/${owner}/${repo}/issues${query}`);
    },

    async get_issue(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const owner = reqStr(args, 'owner');
      const repo = reqStr(args, 'repo');
      return call('GET', `/repos/${owner}/${repo}/issues/${reqNum(args, 'issue_number')}`);
    },

    async create_pull_request(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const owner = reqStr(args, 'owner');
      const repo = reqStr(args, 'repo');
      const body: Record<string, unknown> = {
        title: reqStr(args, 'title'),
        head: reqStr(args, 'head'),
        base: optStr(args, 'base') ?? 'main',
      };
      const prBody = optStr(args, 'body');
      if (prBody) body.body = prBody;
      const draft = optBool(args, 'draft');
      if (draft !== undefined) body.draft = draft;
      return call('POST', `/repos/${owner}/${repo}/pulls`, body);
    },

    async list_pull_requests(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const owner = reqStr(args, 'owner');
      const repo = reqStr(args, 'repo');
      const query = qs({
        state: optStr(args, 'state'),
        sort: optStr(args, 'sort'),
        direction: optStr(args, 'direction'),
        per_page: optNum(args, 'per_page'),
      });
      return call('GET', `/repos/${owner}/${repo}/pulls${query}`);
    },

    async get_pull_request(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const owner = reqStr(args, 'owner');
      const repo = reqStr(args, 'repo');
      return call('GET', `/repos/${owner}/${repo}/pulls/${reqNum(args, 'pr_number')}`);
    },

    async merge_pull_request(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const owner = reqStr(args, 'owner');
      const repo = reqStr(args, 'repo');
      const prNumber = reqNum(args, 'pr_number');
      const body: Record<string, unknown> = {};
      const method = optStr(args, 'merge_method');
      if (method) body.merge_method = method;
      const commitTitle = optStr(args, 'commit_title');
      if (commitTitle) body.commit_title = commitTitle;
      return call('PUT', `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, body);
    },

    async get_file_contents(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const owner = reqStr(args, 'owner');
      const repo = reqStr(args, 'repo');
      const path = reqStr(args, 'path');
      const query = qs({ ref: optStr(args, 'ref') });
      const result = await call('GET', `/repos/${owner}/${repo}/contents/${path}${query}`);

      // For a single file, decode the base64 content into readable text.
      if (
        result &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        'content' in result &&
        (result as { encoding?: string }).encoding === 'base64'
      ) {
        const file = result as { content: string };
        return { ...result, decodedContent: decodeBase64(file.content) };
      }
      return result;
    },

    async create_or_update_file(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const owner = reqStr(args, 'owner');
      const repo = reqStr(args, 'repo');
      const path = reqStr(args, 'path');
      const content = reqStr(args, 'content');
      const message = reqStr(args, 'message');
      const branch = optStr(args, 'branch');

      // An update needs the current blob SHA; a create must omit it. Look it up.
      let sha: string | undefined;
      try {
        const existing = await call('GET', `/repos/${owner}/${repo}/contents/${path}${qs({ ref: branch })}`);
        if (existing && typeof existing === 'object' && 'sha' in existing) {
          sha = String((existing as { sha: unknown }).sha);
        }
      } catch (err) {
        // Most commonly a 404 — the file doesn't exist yet, so we're creating it.
        log?.debug({ path, reason: (err as Error).message }, 'No existing file SHA; creating new file');
      }

      const body: Record<string, unknown> = {
        message,
        content: Buffer.from(content, 'utf-8').toString('base64'),
      };
      if (branch) body.branch = branch;
      if (sha) body.sha = sha;

      return call('PUT', `/repos/${owner}/${repo}/contents/${path}`, body);
    },

    async search_code(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const query = qs({
        q: reqStr(args, 'query'),
        sort: optStr(args, 'sort'),
        order: optStr(args, 'order'),
        per_page: optNum(args, 'per_page'),
      });
      return call('GET', `/search/code${query}`);
    },

    async list_branches(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<unknown> {
      const call = api(ctx);
      const owner = reqStr(args, 'owner');
      const repo = reqStr(args, 'repo');
      return call('GET', `/repos/${owner}/${repo}/branches${qs({ per_page: optNum(args, 'per_page') })}`);
    },
  },

  async shutdown(): Promise<void> {
    log = undefined;
  },
};
