'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { problemsOf } from '@/components/business/common';
import type { ProtectedPluginTool } from '../../../src/shared/plugin-protection';
interface View {
  name: string;
  title: string;
  level: number;
  tools: ProtectedPluginTool[];
}
const labels = ['', 'Public', 'Internal', 'Confidential', 'Strictly confidential'];
function unpack(result: unknown): unknown {
  const envelope = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
  };
  const text = envelope.content
    ?.filter((v) => v.type === 'text')
    .map((v) => v.text ?? '')
    .join('\n');
  if (envelope.isError) throw Error(text || 'The plugin reported an error.');
  if (envelope.structuredContent !== undefined) return envelope.structuredContent;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}
/** Structured results are text and tables only: no plugin HTML, scripts, links or images. */
function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [count, setCount] = useState(50);
  if (value === null || typeof value !== 'object')
    return <span className="whitespace-pre-wrap break-words">{String(value ?? '—')}</span>;
  if (depth > 3)
    return (
      <details>
        <summary>Details</summary>
        <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(value, null, 2)}</pre>
      </details>
    );
  if (Array.isArray(value)) {
    const objectRows = value.length > 0 && value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
    const columns = objectRows ? [...new Set(value.flatMap((v) => Object.keys(v)))].slice(0, 20) : [];
    return (
      <div className="space-y-2 overflow-x-auto">
        {objectRows ? (
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} className="border-b border-outline-variant p-2">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.slice(0, count).map((v, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c} className="max-w-md border-b border-outline-variant p-2 align-top">
                      <Value value={(v as Record<string, unknown>)[c]} depth={depth + 1} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          value.slice(0, count).map((v, i) => (
            <div key={i}>
              <Value value={v} depth={depth + 1} />
            </div>
          ))
        )}
        {value.length > count && (
          <button type="button" onClick={() => setCount((v) => v + 100)} className="text-primary underline">
            Show more ({value.length - count} remaining)
          </button>
        )}
        {!value.length && <span>No entries</span>}
      </div>
    );
  }
  return (
    <dl className="space-y-3">
      {Object.entries(value as Record<string, unknown>).map(([key, v]) => (
        <div key={key}>
          <dt className="mb-1 text-sm font-semibold">{key}</dt>
          <dd>
            <Value value={v} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function ProtectedPluginView({ name }: { name: string }) {
  const query = useQuery({
    queryKey: ['protected-plugin', name],
    queryFn: () => api.get<View>(`/plugins/${encodeURIComponent(name)}/protected`),
    retry: false,
  });
  if (query.error)
    return (
      <main className="p-6">
        <p role="alert" className="text-error">
          {problemsOf(query.error)}
        </p>
        <a
          href={`/admin/plugins?dataAccess=${encodeURIComponent(name)}`}
          className="mt-4 mr-4 inline-block text-primary underline"
        >
          Data access settings
        </a>
        <button type="button" onClick={() => query.refetch()} className="mt-4 text-primary underline">
          Retry
        </button>
      </main>
    );
  if (!query.data) return <main className="p-6">Loading protected tools…</main>;
  return <Workbench key={`${name}:${query.data.level}`} view={query.data} />;
}
function Workbench({ view }: { view: View }) {
  const [toolName, setToolName] = useState(view.tools[0]?.name ?? '');
  const [forms, setForms] = useState<Record<string, Record<string, string>>>({});
  const [result, setResult] = useState<unknown>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    tool: ProtectedPluginTool;
    args: Record<string, unknown>;
  } | null>(null);
  const tool = view.tools.find((t) => t.name === toolName);
  const values = forms[toolName] ?? {};
  const schema = tool?.inputSchema as
    | {
        properties?: Record<
          string,
          {
            type?: string;
            description?: string;
            enum?: unknown[];
            default?: unknown;
          }
        >;
        required?: string[];
      }
    | undefined;
  const fields = Object.entries(schema?.properties ?? {});
  const set = (key: string, value: string) => setForms({ ...forms, [toolName]: { ...values, [key]: value } });
  const args = () =>
    Object.fromEntries(
      fields
        .filter(([k]) => values[k] !== undefined && values[k] !== '')
        .map(([k, s]) => [
          k,
          s.type === 'object' || s.type === 'array'
            ? JSON.parse(values[k])
            : s.type === 'boolean'
              ? values[k] === 'true'
              : s.type === 'integer' || s.type === 'number'
                ? Number(values[k])
                : values[k],
        ]),
    );
  async function execute(selected: ProtectedPluginTool, input: Record<string, unknown>, approved = false) {
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      const response = await api.post<{ result: unknown }>(
        `/plugins/${encodeURIComponent(view.name)}/protected/call/${encodeURIComponent(selected.name)}`,
        { args: input, ...(approved ? { confirm: true } : {}) },
      );
      setResult(unpack(response.result));
      setConfirm(null);
    } catch (e) {
      if (e instanceof ApiError && (e.body as { code?: string })?.code === 'approval_required')
        setConfirm({ tool: selected, args: input });
      else setError(problemsOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="h-full overflow-auto p-6" data-testid="protected-plugin-view">
      <div className="mx-auto max-w-7xl space-y-6">
        <header>
          <span className="rounded-full bg-secondary-container px-3 py-1 text-xs text-on-secondary-container">
            {labels[view.level]} · Protected view
          </span>
          <h1 className="mt-3 text-2xl font-semibold">{view.title}</h1>
          <p className="mt-2 max-w-3xl text-sm text-on-surface-variant">
            Octipus displays these tools and results directly. You can also describe the work in your existing session;
            its classification is preserved. Complex setup can be handled there without editing JSON.
          </p>
        </header>
        <section className="space-y-4 rounded-xl border border-outline-variant bg-surface-container p-5">
          <label className="block text-sm font-medium">
            Action
            <select
              aria-label="Action"
              disabled={busy || !!confirm}
              className="mt-1 block w-full rounded-lg border border-outline-variant bg-surface px-3 py-2"
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
            >
              {view.tools.map((t) => (
                <option value={t.name} key={t.name}>
                  {t.name.replaceAll('_', ' ')} · {t.effect}
                </option>
              ))}
            </select>
          </label>
          {tool && (
            <>
              <p className="text-sm text-on-surface-variant">{tool.description}</p>
              <div className="grid gap-4 md:grid-cols-2">
                {fields.map(([key, s]) => (
                  <label key={key} className="block text-sm">
                    {key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')}
                    {schema?.required?.includes(key) ? ' *' : ''}
                    {s.type === 'boolean' ? (
                      <select
                        disabled={busy || !!confirm}
                        className="mt-1 block w-full rounded-lg border border-outline-variant bg-surface p-2"
                        value={values[key] ?? ''}
                        onChange={(e) => set(key, e.target.value)}
                      >
                        <option value="">Use default</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    ) : s.enum ? (
                      <select
                        disabled={busy || !!confirm}
                        className="mt-1 block w-full rounded-lg border border-outline-variant bg-surface p-2"
                        value={values[key] ?? ''}
                        onChange={(e) => set(key, e.target.value)}
                      >
                        <option value="">Choose…</option>
                        {s.enum.map((v) => (
                          <option key={String(v)} value={String(v)}>
                            {String(v)}
                          </option>
                        ))}
                      </select>
                    ) : s.type === 'object' || s.type === 'array' ? (
                      <textarea
                        aria-label={key}
                        disabled={busy || !!confirm}
                        className="mt-1 block min-h-28 w-full rounded-lg border border-outline-variant bg-surface p-2 font-mono text-xs"
                        placeholder="Advanced structured input; you can ask your session to configure this instead."
                        value={values[key] ?? ''}
                        onChange={(e) => set(key, e.target.value)}
                      />
                    ) : (
                      <input
                        aria-label={key}
                        disabled={busy || !!confirm}
                        type={s.type === 'integer' || s.type === 'number' ? 'number' : 'text'}
                        className="mt-1 block w-full rounded-lg border border-outline-variant bg-surface p-2"
                        value={values[key] ?? ''}
                        onChange={(e) => set(key, e.target.value)}
                      />
                    )}
                    <span className="mt-1 block text-xs text-on-surface-variant">{s.description}</span>
                  </label>
                ))}
              </div>
              <button
                type="button"
                disabled={busy || !!confirm}
                onClick={() => {
                  try {
                    void execute(tool, args());
                  } catch (e) {
                    setError(problemsOf(e));
                  }
                }}
                className="rounded-lg bg-primary px-4 py-2 text-sm text-on-primary disabled:opacity-50"
              >
                {busy ? 'Running…' : 'Run action'}
              </button>
            </>
          )}
          {confirm && (
            <div
              role="dialog"
              aria-label="Confirm plugin action"
              className="rounded-lg border border-outline-variant p-4"
            >
              <p className="font-medium">Allow {confirm.tool.name.replaceAll('_', ' ')}?</p>
              <p className="mt-1 text-sm">{confirm.tool.description}</p>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(confirm.args, null, 2)}
              </pre>
              <div className="mt-3 flex gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void execute(confirm.tool, confirm.args, true)}
                  className="rounded-lg bg-primary px-3 py-2 text-on-primary"
                >
                  Allow once
                </button>
                <button type="button" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="whitespace-pre-wrap text-error">
              {error}
            </p>
          )}
        </section>
        {result !== undefined && (
          <section
            className="rounded-xl border border-outline-variant bg-surface-container p-5"
            aria-label="Plugin result"
          >
            <h2 className="mb-4 text-lg font-semibold">Result</h2>
            <Value value={result} />
          </section>
        )}
      </div>
    </main>
  );
}
