/**
 * Live artifact refresh engine — fetches data for one source, normalizes it,
 * writes a snapshot, updates source status. Loud failure: errors log via
 * coreLogger AND surface in `artifact_data_sources.last_error`. Cross-source
 * principal isolation is enforced — every fetch runs as the source's
 * `principalId`, never the requesting viewer.
 */

import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import type { ArtifactDataSource } from '@/db/schema/artifact-data-sources';
import { coreLogger } from '@/utils/logger';
import { publishArtifactDataUpdated, publishArtifactSourceError } from './events';
import { artifactLifecycleBus } from './lifecycle-bus';

export interface RefreshResult {
  ok: boolean;
  snapshotId?: string;
  error?: string;
  payload?: unknown;
}

interface SourceConfigBase {
  [key: string]: unknown;
}

interface ToolSourceConfig extends SourceConfigBase {
  tool: string; // e.g. 'websearch__search'
  params?: Record<string, unknown>;
}

interface HttpSourceConfig extends SourceConfigBase {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  jsonpath?: string;
}

interface RssSourceConfig extends SourceConfigBase {
  url: string;
}

interface McpSourceConfig extends SourceConfigBase {
  server: string;
  tool: string;
  params?: Record<string, unknown>;
}

interface SkillQuerySourceConfig extends SourceConfigBase {
  skill: string;
  prompt: string;
}

/** Public entrypoint — refresh one source by id. */
export async function refreshSource(sourceId: string): Promise<RefreshResult> {
  const source = await artifactsRepository.getSource(sourceId);
  if (!source) {
    coreLogger.error({ sourceId }, 'artifact.refresh.source_missing');
    return { ok: false, error: 'source not found' };
  }

  let payload: unknown;
  try {
    payload = await dispatch(source);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    coreLogger.error(
      { sourceId, kind: source.kind, error: message },
      'artifact.refresh.failed',
    );
    await artifactsRepository.updateSourceStatus(sourceId, { status: 'error', error: message });
    publishArtifactSourceError(source.artifactId, source.name, message);
    return { ok: false, error: message };
  }

  const snapshot = await artifactsRepository.createSnapshot({
    sourceId,
    payloadJson: payload,
  });
  await artifactsRepository.updateSourceStatus(sourceId, { status: 'ok', error: null });
  publishArtifactDataUpdated(source.artifactId, source.name, snapshot.id, snapshot.capturedAt);
  artifactLifecycleBus.emitEvent({
    type: 'artifact:data_refreshed',
    artifactId: source.artifactId,
    sourceName: source.name,
    snapshotId: snapshot.id,
  });

  // Bound history per source (keep newest 50). Loud failure on prune errors,
  // but they should never block the snapshot write.
  artifactsRepository.pruneSnapshots(sourceId, 50).catch((e) => {
    coreLogger.error({ sourceId, error: (e as Error).message }, 'artifact.refresh.prune_failed');
  });

  coreLogger.info(
    { sourceId, kind: source.kind, snapshotId: snapshot.id },
    'artifact.refresh.ok',
  );
  return { ok: true, snapshotId: snapshot.id, payload };
}

async function dispatch(source: ArtifactDataSource): Promise<unknown> {
  const cfg = source.configJson ?? {};
  switch (source.kind) {
    case 'tool':
      return runTool(cfg as ToolSourceConfig, source.principalId);
    case 'http':
      return runHttp(source);
    case 'rss':
      return runRss(cfg as RssSourceConfig);
    case 'mcp':
      return runMcp(cfg as McpSourceConfig, source.principalId);
    case 'skill_query':
      return runSkillQuery(cfg as SkillQuerySourceConfig, source.principalId);
    case 'toolbox':
      return runToolbox(source);
    default:
      throw new Error(`unknown source kind: ${source.kind}`);
  }
}

// ── toolbox ──────────────────────────────────────────────────────────
async function runToolbox(source: ArtifactDataSource): Promise<unknown> {
  if (!source.toolId) {
    throw new Error(`toolbox source ${source.id}: missing tool_id`);
  }
  const { dispatchCollector } = await import('./toolbox');
  // Workspace id isn't stored on the source row — fetch via the artifact.
  // Cheap: artifact lookup is a single PK select and refresh runs at most
  // every 30s per source.
  const artifact = await artifactsRepository.getById(source.artifactId);
  if (!artifact) throw new Error(`toolbox source ${source.id}: artifact missing`);
  return dispatchCollector(source.toolId, source.configJson ?? {}, {
    principalId: source.principalId,
    workspaceId: artifact.workspaceId,
    artifactId: source.artifactId,
    nodeName: source.name,
  });
}

// ── tool ─────────────────────────────────────────────────────────────
async function runTool(cfg: ToolSourceConfig, principalId: string): Promise<unknown> {
  if (!cfg.tool) throw new Error('tool source: missing config.tool');

  const { getToolRegistry } = await import('@/tools/registry');
  const registry = getToolRegistry();
  const handler = registry.getAllToolHandlers().find((h) => h.name === cfg.tool);
  if (!handler) throw new Error(`tool not registered: ${cfg.tool}`);

  const ctx = buildSyntheticContext(principalId);
  return handler.execute(cfg.params ?? {}, ctx);
}

// ── http ─────────────────────────────────────────────────────────────
async function runHttp(source: ArtifactDataSource): Promise<unknown> {
  const cfg = (source.configJson ?? {}) as HttpSourceConfig;
  if (!cfg.url) throw new Error('http source: missing config.url');
  const artifact = await artifactsRepository.getById(source.artifactId);
  if (!artifact) throw new Error(`http source ${source.id}: artifact missing`);
  const headers = await resolveVaultHeaders(cfg.headers ?? {}, {
    principalId: source.principalId,
    workspaceId: artifact.workspaceId,
  });
  const res = await fetch(cfg.url, {
    method: cfg.method ?? 'GET',
    headers,
    body: cfg.body !== undefined ? JSON.stringify(cfg.body) : undefined,
  });
  if (!res.ok) throw new Error(`http ${res.status}: ${res.statusText}`);
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  return cfg.jsonpath ? applyJsonPath(data, cfg.jsonpath) : data;
}

export interface VaultResolveContext {
  /** Owning principal — used as the vault tenant key. Required. */
  principalId: string;
  /** Workspace the artifact lives in. Lets workspace-scoped secrets override. */
  workspaceId?: string | null;
}

const VAULT_PLACEHOLDER_RE = /\$\{vault\.([^}]+)\}/g;

/**
 * Resolve `${vault.<key>}` placeholders in header values via a real vault
 * lookup. Throws if any referenced key is unknown / unreadable for the
 * principal — fail loud, per the house rules. Header values may contain
 * multiple placeholders; all are resolved before fetch.
 */
export async function resolveVaultHeaders(
  headers: Record<string, string>,
  ctx: VaultResolveContext,
): Promise<Record<string, string>> {
  if (!ctx?.principalId) {
    throw new Error('resolveVaultHeaders: missing principalId — refusing to resolve vault placeholders without an owning principal');
  }
  // Collect every distinct key referenced across all headers so we only
  // hit the vault once per name even if reused (e.g. same token in two
  // headers).
  const keys = new Set<string>();
  for (const v of Object.values(headers)) {
    if (typeof v !== 'string') continue;
    for (const m of v.matchAll(VAULT_PLACEHOLDER_RE)) {
      const name = m[1]?.trim();
      if (name) keys.add(name);
    }
  }

  if (keys.size === 0) {
    // Nothing to resolve — return headers as-is (but still typed Record<string,string>).
    return { ...headers };
  }

  const { getVault } = await import('@/security/vault');
  const vault = getVault();
  const resolved: Record<string, string> = {};
  await Promise.all(
    [...keys].map(async (name) => {
      const value = await vault.getByName(ctx.principalId, name, {
        workspaceId: ctx.workspaceId ?? null,
      });
      if (value == null) {
        throw new Error(
          `vault: secret "${name}" not found for principal ${ctx.principalId}` +
            (ctx.workspaceId ? ` (workspace ${ctx.workspaceId})` : '') +
            ' — store it via the vault API or fix the placeholder name',
        );
      }
      resolved[name] = value;
    }),
  );

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'string') {
      out[k] = v;
      continue;
    }
    out[k] = v.replace(VAULT_PLACEHOLDER_RE, (_, name) => resolved[(name as string).trim()] ?? '');
  }
  return out;
}

/** Minimal dotted path: `a.b.0.c`. Returns `undefined` if path misses. */
export function applyJsonPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

// ── rss ──────────────────────────────────────────────────────────────
async function runRss(cfg: RssSourceConfig): Promise<{ items: RssItem[] }> {
  if (!cfg.url) throw new Error('rss source: missing config.url');
  const res = await fetch(cfg.url, { headers: { accept: 'application/rss+xml, application/xml' } });
  if (!res.ok) throw new Error(`rss ${res.status}`);
  const xml = await res.text();
  return { items: parseRss(xml) };
}

export interface RssItem {
  title: string;
  link: string;
  pubDate: string | null;
  summary: string;
}

/** Tiny regex-based RSS/Atom item extractor — avoids new dependency. */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[2];
    const title = stripCdata(pick(block, 'title')) ?? '';
    const link =
      stripCdata(pick(block, 'link')) ??
      attr(block.match(/<link[^>]*href="([^"]+)"/i)?.[1]) ??
      '';
    const pubDate =
      stripCdata(pick(block, 'pubDate')) ?? stripCdata(pick(block, 'updated')) ?? null;
    const summary =
      stripCdata(pick(block, 'description')) ?? stripCdata(pick(block, 'summary')) ?? '';
    items.push({ title: title.trim(), link: (link ?? '').trim(), pubDate, summary: summary.trim() });
  }
  return items;
}

function pick(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? m[1] : null;
}
function stripCdata(s: string | null): string | null {
  if (s == null) return null;
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}
function attr(s: string | undefined): string | undefined {
  return s;
}

// ── mcp ──────────────────────────────────────────────────────────────
async function runMcp(cfg: McpSourceConfig, _principalId: string): Promise<unknown> {
  if (!cfg.server || !cfg.tool) throw new Error('mcp source: missing server/tool');
  const { getMCPBridge } = await import('@/mcp');
  const bridge = getMCPBridge();
  return bridge.callTool(cfg.server, cfg.tool, (cfg.params ?? {}) as Record<string, unknown>);
}

// ── skill_query ──────────────────────────────────────────────────────
async function runSkillQuery(
  cfg: SkillQuerySourceConfig,
  _principalId: string,
): Promise<unknown> {
  if (!cfg.skill || !cfg.prompt) throw new Error('skill_query: missing skill/prompt');
  // Phase 13 hooks in workspace-level rate limit before allowing model spend.
  // Until then this kind is gated off at the API layer; throw if invoked.
  throw new Error('skill_query refresh not yet enabled (rate limit pending)');
}

// ── helpers ──────────────────────────────────────────────────────────
export function buildSyntheticContext(principalId: string): import('@/core/types').AgentContext {
  const now = new Date();
  return {
    id: `artifact-refresh:${principalId}`,
    sessionId: `artifact-refresh:${principalId}`,
    userId: principalId,
    topic: 'artifact-refresh',
    model: '',
    role: 'system',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    metadata: { source: 'artifact-refresh' },
  };
}
