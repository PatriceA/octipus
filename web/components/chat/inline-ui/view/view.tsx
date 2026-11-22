'use client';

/**
 * A declarative view drawn as the app's own React components
 * (docs/plans/inline-ui-views-spec.md §5): no frame, no generated code, text
 * nodes only. The data model lives here; inputs write it through
 * `setPointer`, buttons run their actions with `runViewActions`, and an event
 * goes to `onEvent` (the block decides how it is sent, §4).
 */
import { Component, type ErrorInfo, type ReactNode, useCallback, useId, useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  type ExprScope,
  type FormatOptions,
  getPointer,
  type InlineUiView as InlineUiViewDoc,
  type InlineUiViewComponent,
  type InlineUiViewState,
  isTruthy,
  type JsonObject,
  type JsonValue,
  type PathRef,
  type ResolvedEvent,
  resolveDynamic,
  resolvePath,
  runViewActions,
  setPointer,
  viewScope,
} from '../../../../../src/shared/inline-ui/view';
import { type ResolvedProps, resolveProps, type ViewRuntime, ViewRuntimeContext, useViewRuntime } from './runtime';
import { Card, Column, Divider, Row, Steps, Tabs } from './layout';
import { Badge, KeyValue, Link, Progress, Stat, Text } from './display';
import { Table } from './table';
import { Chart } from './chart';
import { Button, CheckBox, ChoicePicker, DateTimeInput, Slider, TextField } from './inputs';

/** What a click on a button with an `event` action answers. */
export interface InlineUiViewEvent extends ResolvedEvent {
  componentId: string;
  /** The data model at the click, after the click's own `set` steps. */
  data: JsonObject;
}

export interface InlineUiViewProps {
  view: InlineUiViewDoc;
  /** The data model to start from; else the stored answer's, else the view's own. */
  initialData?: JsonObject;
  /** A stored answer (§4): the view opens as answered. */
  state?: InlineUiViewState | null;
  /** Nothing can be changed or pressed. */
  disabled?: boolean;
  /** A streaming preview: inputs off, the data model follows the view as it grows, no status line. */
  preview?: boolean;
  /** Resolves true when the answer was sent, false when the user chose not to; rejects with the reason it was not sent. */
  onEvent?: (event: InlineUiViewEvent) => Promise<boolean>;
  /** Why answers cannot be sent here (an admin acting as the user, a read-only member). */
  eventsOff?: string | null;
  /** The server refused the last answer after it went out (a new object each time). */
  refusal?: { message: string } | null;
  untrusted?: boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function viewerFormat(): FormatOptions {
  const opts: FormatOptions = {};
  if (typeof navigator !== 'undefined' && navigator.language) opts.locale = navigator.language;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone) opts.timeZone = zone;
  return opts;
}

/** The first required text field (outside templates, and not hidden) that is still empty, by label. */
function missingRequired(view: InlineUiViewDoc, data: JsonObject, format: FormatOptions): string | null {
  const scope = viewScope(view, data, format);
  for (const c of view.components) {
    if (c.component !== 'TextField' || !c.required || !c.value['@path'].startsWith('/')) continue;
    try {
      if (c.visible !== undefined && !isTruthy(resolveDynamic(c.visible, scope))) continue;
      const value = getPointer(data, c.value['@path']);
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return c.label;
    } catch (err) {
      // The field's own inline error says what is wrong; it does not block the answer.
      console.warn('[inline-ui] a required field could not be checked', err);
    }
  }
  return null;
}

export function InlineUiView(props: InlineUiViewProps) {
  return (
    <ViewErrorBoundary>
      <ViewBody {...props} />
    </ViewErrorBoundary>
  );
}

function ViewBody({ view, initialData, state, disabled, preview, onEvent, eventsOff, refusal, untrusted }: InlineUiViewProps) {
  const hintId = useId();
  const [ownData, setOwnData] = useState<JsonObject>(() => initialData ?? state?.data ?? view.data);
  // The data model as last written, read by every write and click: a write
  // is computed here (where its error can be caught), and two writes in one
  // tick (two sliders filling in their minimum) build on each other.
  const latest = useRef(ownData);
  const commit = (next: JsonObject) => {
    latest.current = next;
    setOwnData(next);
  };
  // Number fields whose text is not a valid number now, by field: the answer waits for them.
  const [badNumbers, setBadNumbers] = useState<ReadonlyMap<string, string>>(() => new Map());
  const reportNumber = useCallback((key: string, label: string | null) => {
    setBadNumbers((prev) => {
      if ((prev.get(key) ?? null) === label) return prev;
      const next = new Map(prev);
      if (label === null) next.delete(key); else next.set(key, label);
      return next;
    });
  }, []);
  const [answered, setAnswered] = useState(!!state);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal that arrives after the send: the answer is open again, with why.
  const [seenRefusal, setSeenRefusal] = useState(refusal);
  if (refusal !== seenRefusal) {
    setSeenRefusal(refusal);
    if (refusal) { setAnswered(false); setError(refusal.message); }
  }

  const data = preview ? view.data : ownData;
  const format = useMemo(() => viewerFormat(), []);
  const components = useMemo(() => new Map(view.components.map((c) => [c.id, c])), [view]);
  const missing = useMemo(() => (preview ? null : missingRequired(view, data, format)), [view, data, format, preview]);
  // What the user must do before answering: fill in a required field, or fix a number field.
  const badNumber = preview ? null : badNumbers.values().next().value ?? null;
  const todo = missing ? `Fill in “${missing}”` : badNumber ? `Fix “${badNumber}”` : null;
  const inert = !!disabled || !!preview;
  const eventBlock = inert ? 'Not available here'
    : answered ? 'Answer sent — choose Change answer to answer again'
    : eventsOff ?? (sending ? 'Sending…' : todo ? `${todo} first` : null);

  const send = async (event: ResolvedEvent, componentId: string, at: JsonObject) => {
    if (!onEvent) return;
    setSending(true);
    try {
      if (await onEvent({ ...event, componentId, data: at })) setAnswered(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const rt: ViewRuntime = {
    view,
    components,
    data,
    format,
    untrusted: !!untrusted,
    readOnly: answered || inert,
    inert,
    eventBlock,
    eventBlockId: hintId,
    reportNumber,
    write: (pointer, value) => {
      if (inert) return;
      let next: JsonObject;
      try {
        // Computed now, not in a state updater: an updater runs inside React,
        // where a throw would take the whole view down instead of landing here.
        next = setPointer(latest.current, pointer, value);
      } catch (err) {
        setError(errorText(err));
        return;
      }
      commit(next);
    },
    click: (componentId, scope) => {
      if (inert) return;
      setError(null);
      let result: ReturnType<typeof runViewActions>;
      try {
        result = runViewActions(view, componentId, { ...scope, data: latest.current });
      } catch (err) {
        // An unsafe link or an unwritable path stops the whole click, before any effect.
        setError(`${componentId}: ${errorText(err)}`);
        return;
      }
      commit(result.data);
      // One answer per click, deliberately: a button listing several `event`
      // steps sends the first (with the data after all its `set` steps) and
      // warns (covered by tests/web/inline-ui-view.spec.ts).
      const events = result.effects.filter((e) => e.type === 'event');
      if (events.length > 1) console.warn(`[inline-ui] button "${componentId}" has ${events.length} events; only the first is sent`);
      for (const effect of result.effects) {
        if (effect.type === 'openUrl') window.open(effect.url, '_blank', 'noopener,noreferrer');
      }
      if (events[0]?.type === 'event') void send(events[0].event, componentId, result.data);
    },
  };

  return (
    <ViewRuntimeContext.Provider value={rt}>
      <div className="flex flex-col gap-3 p-3 text-sm text-on-surface min-w-0" data-testid="inline-ui-view">
        <ViewNode id={view.root} scope={viewScope(view, data, format)} />
        {!preview && <p role="status" className="sr-only">{answered ? 'Answer sent' : sending ? 'Sending your answer' : ''}</p>}
        {!preview && (answered || sending || eventsOff || todo) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant" data-testid="inline-ui-view-status">
            {answered ? <span>Answer sent</span> : sending ? <span>Sending…</span> : null}
            {answered && !disabled && (
              <button
                type="button"
                onClick={() => { setAnswered(false); setError(null); }}
                className="rounded-md border border-outline-variant px-2 py-1 text-on-surface hover:bg-surface-container-high"
              >Change answer</button>
            )}
            {!answered && !sending && (eventsOff || todo) && <span id={hintId}>{eventsOff ?? `${todo} to answer.`}</span>}
          </div>
        )}
        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-error" data-testid="inline-ui-view-error">
            <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}
      </div>
    </ViewRuntimeContext.Provider>
  );
}

/** A small error in place of one component; the rest of the view renders. */
export function ComponentError({ id, message }: { id: string; message: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-error/40 bg-error-container/30 px-2 py-1 text-xs text-on-surface" data-testid="inline-ui-component-error">
      <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0 text-error" aria-hidden />
      <span className="min-w-0 break-words"><span className="font-mono">{id}</span>: {message}</span>
    </p>
  );
}

/** One component of the view, by id, in `scope` (a template copy has its item there). */
export function ViewNode({ id, scope }: { id: string; scope: ExprScope }) {
  const rt = useViewRuntime();
  const c = rt.components.get(id);
  if (!c) return <ComponentError id={id} message="the view has no component with this id" />;
  let r: ResolvedProps;
  try {
    r = resolveProps(c, scope);
  } catch (err) {
    return <ComponentError id={id} message={errorText(err)} />;
  }
  if (c.visible !== undefined && !isTruthy(r.visible)) return null;
  return (
    <NodeBoundary id={id} resetKey={rt.data}>
      <ComponentSwitch c={c} r={r} scope={scope} />
    </NodeBoundary>
  );
}

function ComponentSwitch({ c, r, scope }: { c: InlineUiViewComponent; r: ResolvedProps; scope: ExprScope }) {
  switch (c.component) {
    case 'Column': return <Column c={c} r={r} scope={scope} />;
    case 'Row': return <Row c={c} r={r} scope={scope} />;
    case 'Card': return <Card c={c} r={r} scope={scope} />;
    case 'Tabs': return <Tabs c={c} r={r} scope={scope} />;
    case 'Steps': return <Steps c={c} r={r} scope={scope} />;
    case 'Divider': return <Divider />;
    case 'Text': return <Text c={c} r={r} scope={scope} />;
    case 'Stat': return <Stat c={c} r={r} scope={scope} />;
    case 'Badge': return <Badge c={c} r={r} scope={scope} />;
    case 'Progress': return <Progress c={c} r={r} scope={scope} />;
    case 'KeyValue': return <KeyValue c={c} r={r} scope={scope} />;
    case 'Table': return <Table c={c} r={r} scope={scope} />;
    case 'Chart': return <Chart c={c} r={r} scope={scope} />;
    case 'Link': return <Link c={c} r={r} scope={scope} />;
    case 'TextField': return <TextField c={c} r={r} scope={scope} />;
    case 'Slider': return <Slider c={c} r={r} scope={scope} />;
    case 'CheckBox': return <CheckBox c={c} r={r} scope={scope} />;
    case 'ChoicePicker': return <ChoicePicker c={c} r={r} scope={scope} />;
    case 'DateTimeInput': return <DateTimeInput c={c} r={r} scope={scope} />;
    case 'Button': return <Button c={c} r={r} scope={scope} />;
  }
}

/** The absolute pointer an input writes, its current value, and how to write it. */
export function useBinding(value: PathRef, scope: ExprScope): { current: JsonValue | undefined; write: (v: JsonValue) => void } {
  const rt = useViewRuntime();
  const path = resolvePath(value['@path'], scope);
  return { current: getPointer(rt.data, path), write: (v) => rt.write(path, v) };
}

/**
 * A render error in one component (a value no format accepts, a bug) shows
 * in its place. It clears when the data model changes, so a value that only
 * fails for some inputs recovers.
 */
class NodeBoundary extends Component<{ id: string; resetKey: unknown; children: ReactNode }, { error: string | null; resetKey: unknown }> {
  override state = { error: null as string | null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(err: unknown) {
    return { error: errorText(err) };
  }

  static getDerivedStateFromProps(props: { resetKey: unknown }, state: { error: string | null; resetKey: unknown }) {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  override componentDidCatch(err: unknown, info: ErrorInfo) {
    console.warn(`[inline-ui] component "${this.props.id}" failed to render`, err, info.componentStack);
  }

  override render() {
    return this.state.error ? <ComponentError id={this.props.id} message={this.state.error} /> : this.props.children;
  }
}

/** Anything the per-component errors did not catch: the view is replaced by one line, the conversation stays. */
class ViewErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };

  static getDerivedStateFromError(err: unknown) {
    return { error: errorText(err) };
  }

  override componentDidCatch(err: unknown, info: ErrorInfo) {
    console.warn('[inline-ui] a view failed to render', err, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <p role="alert" className="flex items-start gap-2 px-3 py-3 text-xs text-on-surface" data-testid="inline-ui-view-failed">
        <TriangleAlert className="h-4 w-4 shrink-0 text-error" aria-hidden />
        <span className="min-w-0 break-words">This interactive answer could not be displayed: {this.state.error}</span>
      </p>
    );
  }
}
