/**
 * Per-tool work-stream renderers — `.octipus/end-user-ux-design.md` Thread 1.
 *
 * Pure functions that map a tool call (`name` + `args`) and, when available,
 * its `result` into a human one-liner plus a structured, size-capped preview
 * (`ToolActivityRender`). The registry is keyed by the full tool name
 * (`<toolId>__<action>`, e.g. `filesystem__read_file`); anything without a
 * dedicated renderer degrades gracefully through `genericRender`, so every
 * built-in tool gets *something* better than "used <tool>".
 *
 * These run server-side in `tool-executor.ts`. Inputs/results returned by
 * built-in tools are already secret-redacted by `BaseTool.execute` (M2 egress
 * control); the renderers additionally size-cap every string so a 10 MB file
 * read can't blow up the event bus (the swarm-bandwidth concern that made us
 * filter `thought` events).
 */

import {
  type ToolActivityRender,
  type ToolResultPreview,
  WORK_STREAM_LIST_CAP,
  WORK_STREAM_PREVIEW_CAP,
} from '@/shared/work-stream';

type Args = Record<string, unknown>;

/** A renderer sees the args always; `result` only once the tool has returned. */
type Renderer = (args: Args, result: unknown, hasResult: boolean) => ToolActivityRender;

// ── helpers ───────────────────────────────────────────────────────

/** Cap a string to `max` chars, marking truncation with an ellipsis. */
function cap(s: string, max = WORK_STREAM_PREVIEW_CAP): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max - 1) + '…', truncated: true };
}

/** Last path segment, for compact titles ("poem.md" from "/a/b/poem.md"). */
function baseName(p: string): string {
  const cleaned = p.replace(/[/\\]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
}

function asRecord(v: unknown): Args | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Args) : null;
}

/** One-line, capped JSON of arbitrary args/result for the generic fallback. */
function oneLineJson(v: unknown, max = 200): string {
  let text: string;
  try {
    text = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    text = String(v);
  }
  if (text == null) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return cap(oneLine, max).text;
}

/** Strip the `<toolId>__` namespace for human display ("read_file"). */
function actionName(toolName: string): string {
  const i = toolName.indexOf('__');
  return i >= 0 ? toolName.slice(i + 2) : toolName;
}

// ── filesystem ────────────────────────────────────────────────────

const renderRead: Renderer = (args, result, hasResult) => {
  const path = str(args.path);
  const name = baseName(path) || path;
  const render: ToolActivityRender = {
    title: `Read ${name}`,
    input: { kind: 'path', value: path },
  };
  if (hasResult) {
    const rec = asRecord(result);
    const content = rec ? str(rec.content) : str(result);
    const lines = content ? content.split('\n').length : 0;
    const { text, truncated } = cap(content);
    render.result = { kind: 'text', text, truncated };
    render.title = `Read ${name}${lines ? ` (${lines} line${lines === 1 ? '' : 's'})` : ''}`;
  }
  return render;
};

function fileWriteRenderer(verb: string): Renderer {
  return (args, result, hasResult) => {
    const path = str(args.path);
    const name = baseName(path) || path;
    const render: ToolActivityRender = {
      title: `${verb} ${name}`,
      input: { kind: 'path', value: path },
    };
    if (hasResult) {
      const rec = asRecord(result);
      const bytes = rec && typeof rec.bytesWritten === 'number' ? rec.bytesWritten : undefined;
      const resolved = rec && typeof rec.path === 'string' ? rec.path : path;
      render.result = { kind: 'file', path: resolved, bytes };
      if (bytes != null) render.title = `${verb} ${name} (${bytes} byte${bytes === 1 ? '' : 's'})`;
    }
    return render;
  };
}

const renderList: Renderer = (args, result, hasResult) => {
  const path = str(args.path) || '.';
  const recursive = args.recursive === true;
  const render: ToolActivityRender = {
    title: `Listed ${baseName(path) || path}`,
    input: { kind: 'path', value: path, detail: recursive ? 'recursive' : undefined },
  };
  if (hasResult) {
    const rec = asRecord(result);
    const entries = rec && Array.isArray(rec.entries) ? rec.entries : [];
    const items = entries
      .slice(0, WORK_STREAM_LIST_CAP)
      .map((e) => {
        const er = asRecord(e);
        if (!er) return str(e);
        const n = str(er.name);
        return er.isDirectory ? `${n}/` : n;
      })
      .filter(Boolean);
    render.result = { kind: 'list', items, total: entries.length };
    render.title = `Listed ${baseName(path) || path} (${entries.length} item${entries.length === 1 ? '' : 's'})`;
  }
  return render;
};

function fsMutationRenderer(verb: string): Renderer {
  return (args, result, hasResult) => {
    const path = str(args.path) || str(args.source) || str(args.destination);
    const name = baseName(path) || path;
    const render: ToolActivityRender = {
      title: `${verb} ${name}`,
      input: { kind: 'path', value: path },
    };
    if (hasResult) {
      const rec = asRecord(result);
      const resolved = rec && typeof rec.path === 'string' ? rec.path : path;
      render.result = { kind: 'file', path: resolved };
    }
    return render;
  };
}

// ── shell ─────────────────────────────────────────────────────────

const renderShell: Renderer = (args, result, hasResult) => {
  const command = str(args.command);
  const short = cap(command, 80).text;
  const render: ToolActivityRender = {
    title: `Ran ${short}`,
    input: { kind: 'command', value: cap(command, 400).text },
  };
  if (hasResult) {
    const rec = asRecord(result);
    const code = rec && typeof rec.exitCode === 'number' ? rec.exitCode : rec?.killed ? 137 : 0;
    const stdout = rec ? str(rec.stdout) : str(result);
    const stderr = rec ? str(rec.stderr) : '';
    const ok = rec?.outcome ? rec.outcome === 'success' : code === 0;
    const combined = (stdout || stderr).trimEnd();
    // Keep the *tail* — the end of a build/test log is what carries the verdict.
    const tail = combined.length > WORK_STREAM_PREVIEW_CAP
      ? '…' + combined.slice(combined.length - WORK_STREAM_PREVIEW_CAP + 1)
      : combined;
    render.result = { kind: 'exit', code, tail, ok };
    render.title = `Ran ${short} → exit ${code}`;
  }
  return render;
};

// ── web ───────────────────────────────────────────────────────────

const renderSearch: Renderer = (args, result, hasResult) => {
  const query = str(args.query ?? args.q ?? args.search ?? args.term);
  const render: ToolActivityRender = {
    title: query ? `Searched: ${cap(query, 80).text}` : 'Searched',
    input: { kind: 'query', value: cap(query, 200).text },
  };
  if (hasResult) {
    const items = extractListItems(result);
    if (items) render.result = { kind: 'list', items: items.slice(0, WORK_STREAM_LIST_CAP), total: items.length };
    else render.result = textResult(result);
  }
  return render;
};

const renderFetch: Renderer = (args, result, hasResult) => {
  const url = str(args.url ?? args.uri ?? args.address);
  const render: ToolActivityRender = {
    title: url ? `Fetched ${cap(url, 80).text}` : 'Fetched page',
    input: { kind: 'url', value: cap(url, 400).text },
  };
  if (hasResult) render.result = textResult(result);
  return render;
};

// ── generic fallback ──────────────────────────────────────────────

/** Best-effort list extraction from a heterogeneous search/list result. */
function extractListItems(result: unknown): string[] | null {
  if (Array.isArray(result)) return result.map((r) => oneLineJson(r, 120));
  const rec = asRecord(result);
  if (!rec) return null;
  for (const key of ['results', 'items', 'hits', 'matches', 'entries']) {
    const v = rec[key];
    if (Array.isArray(v)) {
      return v.map((r) => {
        const rr = asRecord(r);
        return rr ? str(rr.title ?? rr.name ?? rr.url ?? rr.path) || oneLineJson(rr, 120) : oneLineJson(r, 120);
      });
    }
  }
  return null;
}

function textResult(result: unknown): ToolResultPreview {
  if (result == null) return { kind: 'empty' };
  const rec = asRecord(result);
  const raw = rec
    ? str(rec.content ?? rec.text ?? rec.output ?? rec.result ?? result)
    : str(result);
  if (!raw) return { kind: 'empty' };
  const { text, truncated } = cap(raw);
  return { kind: 'text', text, truncated };
}

function genericRender(toolName: string, args: Args, result: unknown, hasResult: boolean): ToolActivityRender {
  const render: ToolActivityRender = { title: `Used ${actionName(toolName)}` };
  if (Object.keys(args).length > 0) {
    render.input = { kind: 'json', value: oneLineJson(args, 200) };
  }
  if (hasResult) render.result = textResult(result);
  return render;
}

// ── registry ──────────────────────────────────────────────────────

const REGISTRY: Record<string, Renderer> = {
  filesystem__read_file: renderRead,
  filesystem__write_file: fileWriteRenderer('Wrote'),
  filesystem__append_file: fileWriteRenderer('Appended to'),
  filesystem__list_directory: renderList,
  filesystem__file_info: fsMutationRenderer('Inspected'),
  filesystem__create_directory: fsMutationRenderer('Created dir'),
  filesystem__delete_file: fsMutationRenderer('Deleted'),
  filesystem__move_file: fsMutationRenderer('Moved'),
  filesystem__copy_file: fsMutationRenderer('Copied'),
  shell__run: renderShell,
  shell__exec_command: renderShell,
};

/**
 * Prefix/suffix matchers for tool families whose action names vary but share a
 * shape (web search, page fetch). Checked after the exact-name registry.
 */
function matchByFamily(toolName: string): Renderer | null {
  const action = actionName(toolName);
  if (/search/.test(action)) return renderSearch;
  if (/(fetch|navigate|^get_document$|open_url)/.test(action)) return renderFetch;
  return null;
}

/**
 * Resolve a tool call (and optional result) to its rendered work-stream shape.
 * `hasResult` distinguishes the `started` phase (args only) from `completed`
 * (args + result) so callers get a sensible title in both. Never throws — a
 * renderer that blows up falls back to the generic shape.
 */
export function renderToolActivity(
  toolName: string,
  args: Args,
  result?: unknown,
  hasResult = false,
): ToolActivityRender {
  const renderer = REGISTRY[toolName] ?? matchByFamily(toolName);
  try {
    return renderer
      ? renderer(args ?? {}, result, hasResult)
      : genericRender(toolName, args ?? {}, result, hasResult);
  } catch {
    // A renderer that chokes on an unexpected shape must not break the stream.
    return { title: `Used ${actionName(toolName)}`, input: { kind: 'json', value: oneLineJson(args, 200) } };
  }
}

/** Whether a dedicated (non-generic) renderer exists for a tool name. */
export function hasDedicatedRenderer(toolName: string): boolean {
  return toolName in REGISTRY || matchByFamily(toolName) != null;
}
