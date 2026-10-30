import type { AgentContext, ToolManifest } from '@/core/types';
import { getExecutionSignal } from '@/core/execution-scope';
import { authenticatedFetch, connectionUrl, connectionFor, readBoundedResponse, readAvailableConnectionProfiles } from '@/security/credential-connections';
import { authenticatedGit } from '@/security/credential-git';
import { BaseTool, createParameterSchema } from '../base-tool';

export class ConnectionsTool extends BaseTool {
  readonly id = 'connections';
  readonly name = 'Authenticated connections';
  readonly version = '1.0.0';
  readonly description = 'Use operator-configured HTTP API and Git connections with named vault credentials, without exposing credentials to tools or scripts';
  getManifest(): ToolManifest { return { id: this.id, name: this.name, version: this.version, description: this.description, permissions: [
    { action: 'read', description: 'List authorized profiles and read HTTP APIs using GET', defaultLevel: 'ALLOW' },
    { action: 'request', description: 'Send an authenticated HTTP API request to an approved service', defaultLevel: 'ASK' },
    { action: 'fetch', description: 'Fetch Git refs into an approved local repository', defaultLevel: 'ASK' },
    { action: 'push', description: 'Push Git refs to an approved remote repository', defaultLevel: 'ASK', dangerous: true },
  ], tools: [] }; }
  protected async registerTools(): Promise<void> {
    this.registerTool('list', 'List connection names and approved origins/methods. Credentials are never returned. If empty, report missing connection configuration, not a missing service or invalid credential.', createParameterSchema({}), async (_args, c) =>
      (await readAvailableConnectionProfiles(c)).filter(p => p.http).map(p => ({ connection: p.id, origin: p.http!.origin, pathPrefix: p.http!.pathPrefix, methods: p.http!.methods, git: p.http!.git, tlsMode:p.http!.tls?.mode??'system',authentication:p.http!.auth.type })), { permissionAction: 'read', readOnly: true });
    const requestSchema = createParameterSchema({
      connection: { type: 'string', required: true, description: 'Configured connection name' }, path: { type: 'string', required: true, description: 'Origin-relative path; e.g. /api/json or /api/v4/projects' },
      timeout: { type: 'number', description: 'Execution timeout in milliseconds (1–600000)', default: 120000 },
      method: { type: 'string', description: 'HTTP method', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
      query: { type: 'object', description: 'Query string fields' },
      headers: { type: 'object', description: 'Non-authentication headers such as Accept or an API version' },
      json: { type: 'object', description: 'JSON request body' }, form: { type: 'object', description: 'Form request fields' },
    });
    const request = async (args: Record<string, unknown>, c: AgentContext) => {
      const p = await connectionFor(String(args.connection), { ...c, agentId: c.id });
      if (args.json !== undefined && args.form !== undefined) throw new Error('Supply either JSON or form fields');
      const path = String(args.path); const url = new URL(path, p.http?.origin);
      for (const [key, value] of Object.entries((args.query ?? {}) as Record<string, string>)) url.searchParams.set(key, String(value));
      // Validate the original path as well; URL construction must not hide an absolute URL.
      connectionUrl(p, path);
      const timeoutMs = args.timeout ?? 120000;
      if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('HTTP timeout must be 1–600000 milliseconds');
      const signal = getExecutionSignal(c); const timeout = AbortSignal.timeout(timeoutMs);
      const { response, mask } = await authenticatedFetch(p, { ...c, agentId: c.id }, url.pathname + url.search, {
        method: String(args.method ?? 'GET'), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { ...(args.headers as Record<string, string> ?? {}), ...(args.json !== undefined ? { 'Content-Type': 'application/json' } : args.form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: args.json !== undefined ? JSON.stringify(args.json) : args.form !== undefined ? new URLSearchParams(args.form as Record<string, string>).toString() : undefined,
      });
      const text = await readBoundedResponse(response);
      let body: unknown = text; if (response.headers.get('content-type')?.includes('application/json')) { try { body = JSON.parse(text); } catch { /* preserve redacted text */ } }
      return mask({ status: response.status, ok: response.ok, redirected: response.status >= 300 && response.status < 400, body });
    };
    this.registerTool('request', 'Authenticated HTTP API request through a configured connection. Use a relative path, method, query, headers and optional JSON/form fields. No secret values or templates. Redirects are not followed. JSON Login connections sign in and refresh internally; request the protected resource, never the login/refresh endpoint.', requestSchema, request, { permissionAction: 'request' });
    this.registerTool('get', 'Read an authenticated HTTP API through a configured connection using GET. Returns status and redacted JSON/text; no secret values or templates.', createParameterSchema({
      connection: { type: 'string', required: true, description: 'Configured connection name' }, path: { type: 'string', required: true, description: 'Origin-relative API path' },
      query: { type: 'object', description: 'Query string fields' }, headers: { type: 'object', description: 'Non-authentication headers' },
      timeout: { type: 'number', description: 'Execution timeout in milliseconds (1–600000)', default: 120000 },
    }), (args, c) => request({ ...args, method: 'GET', json: undefined, form: undefined }, c), { permissionAction: 'read', readOnly: true });
    for (const operation of ['fetch', 'push'] as const) this.registerTool(`git_${operation}`, `Authenticated Git ${operation} using a configured connection. Credentials stay in a temporary HTTP broker, never in git's environment, command line or config. Does not require glab.`, createParameterSchema({
      connection: { type: 'string', required: true, description: 'Configured connection name' }, path: { type: 'string', required: true, description: 'Local repository under the connection repositoryRoots' },
      remotePath: { type: 'string', required: true, description: '/group/project.git on the configured origin' },
      timeout: { type: 'number', description: 'Git timeout in milliseconds (1–1800000)', default: 600000 },
      refspecs: { type: 'array', items: { type: 'string' }, required: true, description: 'Explicit source/destination refs; no flags' },
    }), async (args, c) => authenticatedGit(await connectionFor(String(args.connection), { ...c, agentId: c.id }), { ...c, agentId: c.id }, {
      operation, timeout: args.timeout as number | undefined, path: String(args.path), remotePath: String(args.remotePath), refspecs: args.refspecs as string[],
    }, getExecutionSignal(c)), { permissionAction: operation });
  }
}
export const connectionsTool = new ConnectionsTool();
