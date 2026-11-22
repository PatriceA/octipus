'use client';

/**
 * One interactive answer of kind `view` (docs/plans/inline-ui-views-spec.md
 * §4, §5): part 1's chrome around the view drawn by the page itself. No
 * click-to-run, no frame, no freeze marker and no live-frame cap — no
 * generated code runs. A button's event is the user's answer: sent at once,
 * or through the suggestion strip when the conversation had read outside
 * content (`tainted`), never while an admin acts as the user.
 */
import { Code2, RotateCcw, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { INLINE_UI_LIMITS } from '../../../../src/shared/inline-ui/limits';
import { type InlineUiView as InlineUiViewDoc, viewToAuthored } from '../../../../src/shared/inline-ui/view';
import type { InlineUiBlockData, InlineUiHost, InlineUiSendAction } from './context';
import { SuggestionStrip } from './strip';
import { InlineUiView, type InlineUiViewEvent } from './view/view';

interface PendingStrip {
  action: InlineUiSendAction;
  at: number;
  settle: (sent: boolean) => void;
  fail: (err: unknown) => void;
}

export function LoadedViewBlock({ block, view, host, untrusted }: { block: InlineUiBlockData; view: InlineUiViewDoc; host: InlineUiHost; untrusted?: boolean }) {
  const [showSource, setShowSource] = useState(false);
  // Reset mounts the view again from the view's own data, as if never answered.
  const [resets, setResets] = useState(0);
  const [strip, setStrip] = useState<PendingStrip | null>(null);
  const [refusal, setRefusal] = useState<{ message: string } | null>(null);
  const source = useMemo(() => {
    try {
      return JSON.stringify(viewToAuthored(view), null, 2);
    } catch (err) {
      console.warn('[inline-ui] could not write the view back as JSON', err);
      return `The source could not be shown: ${err instanceof Error ? err.message : String(err)}`;
    }
  }, [view]);

  const eventsOff = host.impersonating
    ? 'Answers are off while you act as another user.'
    : !host.sendAction ? 'Answers cannot be sent from here.' : null;

  const deliver = async (action: InlineUiSendAction) => {
    if (!host.sendAction) throw new Error('Answers cannot be sent from here.');
    setRefusal(null);
    await host.sendAction(action, (message) => setRefusal({ message }));
  };

  const onEvent = (event: InlineUiViewEvent): Promise<boolean> => {
    const action: InlineUiSendAction = {
      blockId: block.id,
      name: event.name,
      componentId: event.componentId,
      context: event.context,
      data: event.data,
      text: event.userMessage,
    };
    if (!block.tainted) return deliver(action).then(() => true);
    // Outside content may have shaped what this button sends: the user reads the full text first (S6).
    return new Promise<boolean>((resolve, reject) => {
      strip?.settle(false);
      setStrip({ action, at: Date.now(), settle: resolve, fail: reject });
    });
  };

  const closeStrip = (sent: boolean) => {
    strip?.settle(sent);
    setStrip(null);
  };

  const settled = (since: number) => Date.now() - since >= INLINE_UI_LIMITS.inputDelayMs;

  return (
    <div>
      <header className="flex items-center gap-2 px-3 py-1.5 border-b border-outline-variant/30 text-xs text-on-surface-variant">
        <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden />
        <h3 className="font-medium text-on-surface truncate text-xs">{block.title}</h3>
        <span className="shrink-0">Interactive answer</span>
        <span className="ml-auto flex items-center gap-1 shrink-0">
          <button type="button" title="View source" aria-pressed={showSource} onClick={() => setShowSource((v) => !v)} className="p-1 rounded hover:bg-surface-container-high"><Code2 className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">View source</span></button>
          <button type="button" title="Reset" data-testid="inline-ui-reset" onClick={() => { closeStrip(false); setRefusal(null); setResets((n) => n + 1); }} className="p-1 rounded hover:bg-surface-container-high"><RotateCcw className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">Reset</span></button>
        </span>
      </header>

      <InlineUiView
        key={resets}
        view={view}
        initialData={resets > 0 ? view.data : undefined}
        state={resets > 0 ? null : block.state}
        onEvent={onEvent}
        eventsOff={eventsOff}
        refusal={refusal}
        untrusted={untrusted}
      />

      {strip && (
        <SuggestionStrip
          title={block.title}
          suggestion={{ text: strip.action.text, at: strip.at }}
          busy={!!host.busy}
          settled={settled}
          onSend={() => {
            const pending = strip;
            setStrip(null);
            deliver(pending.action).then(() => pending.settle(true), pending.fail);
          }}
          onEdit={host.editSuggestion ? () => { host.editSuggestion?.(strip.action.text, block.id); closeStrip(false); } : undefined}
          onDismiss={() => closeStrip(false)}
        />
      )}

      {showSource && (
        <pre className="mx-3 my-2 max-h-80 overflow-auto rounded bg-surface-container p-2 text-[11px] leading-snug whitespace-pre-wrap break-all" data-testid="inline-ui-source">{source}</pre>
      )}

      <footer className="px-3 py-1 border-t border-outline-variant/30 text-[10px] text-on-surface-variant/80">
        Made by the agent · don’t enter passwords or keys here
      </footer>
    </div>
  );
}
