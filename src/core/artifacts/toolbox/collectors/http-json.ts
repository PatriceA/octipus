/**
 * art_collect_http_json — fetch a JSON endpoint and optionally narrow to a
 * dotted JSONPath. Replaces the inline `kind: "http"` config for JSON
 * payloads — non-JSON responses go through `art_collect_http_text`.
 */

import { applyJsonPath, resolveVaultHeaders } from '../../refresh';
import type { ToolboxTool } from '../types';

interface Params {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  jsonpath?: string;
}

export const httpJsonCollector: ToolboxTool<Params, unknown> = {
  id: 'art_collect_http_json',
  family: 'collect',
  description:
    'Fetch a JSON endpoint (GET/POST) and optionally narrow with a dotted JSONPath.',
  keywords: ['http', 'rest', 'api', 'json', 'fetch', 'endpoint'],
  defaultPermission: 'ASK',
  params: {
    url: { type: 'string', required: true, description: 'Absolute HTTP(S) URL.' },
    method: { type: 'string', enum: ['GET', 'POST'], default: 'GET', description: 'HTTP method.' },
    headers: {
      type: 'object',
      description:
        'Request headers. Values may reference vault secrets via ${vault.<key>} placeholders.',
    },
    body: { type: 'object', description: 'JSON body, sent only when method=POST.' },
    jsonpath: {
      type: 'string',
      description: 'Dotted path into the response, e.g. "data.items.0.name".',
    },
  },
  returns:
    'The parsed JSON value, or the value at `jsonpath` if provided. Non-JSON content-types fall back to the raw string.',
  examples: [
    {
      summary: 'Fetch GitHub repo metadata',
      params: { url: 'https://api.github.com/repos/PatriceA/octipus' },
    },
    {
      summary: 'Authenticated POST with vault token',
      params: {
        url: 'https://api.example.com/query',
        method: 'POST',
        headers: { authorization: 'Bearer ${vault.example_api_token}' },
        body: { q: 'select 1' },
        jsonpath: 'rows.0',
      },
    },
  ],
  tips: [
    'Use `art_collect_http_text` when the endpoint returns HTML/XML/CSV — this one assumes JSON.',
    'Vault placeholders in headers are resolved at fetch time; never commit raw tokens in `headers`.',
  ],

  async execute(params, ctx) {
    if (!params.url) throw new Error('art_collect_http_json: missing `url`');
    const headers = await resolveVaultHeaders(params.headers ?? {}, {
      principalId: ctx.principalId,
      workspaceId: ctx.workspaceId,
    });
    const res = await fetch(params.url, {
      method: params.method ?? 'GET',
      headers,
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
    });
    if (!res.ok) throw new Error(`http ${res.status}: ${res.statusText}`);
    const ct = res.headers.get('content-type') ?? '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    return params.jsonpath ? applyJsonPath(data, params.jsonpath) : data;
  },
};

export default httpJsonCollector;
