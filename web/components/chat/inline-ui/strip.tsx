'use client';

/**
 * The strip under a block that holds a message the block suggests (or a
 * view's answer from a conversation that read outside content): the full
 * text, **Send**, **Edit in composer**, **Dismiss**. Nothing is sent without a
 * click here (S6).
 */
import { Send } from 'lucide-react';

export interface Suggestion { text: string; at: number }

export function SuggestionStrip({ title, suggestion, busy, settled, onSend, onEdit, onDismiss }: {
  title: string;
  suggestion: Suggestion;
  busy: boolean;
  settled: (since: number) => boolean;
  onSend?: () => void;
  onEdit?: () => void;
  onDismiss: () => void;
}) {
  const guard = (fn?: () => void) => () => { if (settled(suggestion.at)) fn?.(); };
  return (
    <div className="px-3 py-2 border-t border-outline-variant/30 text-xs space-y-1.5" data-testid="inline-ui-suggestion" role="group" aria-label="Suggested message">
      <p className="text-on-surface-variant">Suggested by “{title}” — {suggestion.text.length} characters:</p>
      <div className="max-h-32 overflow-auto rounded bg-surface-container px-2 py-1.5 whitespace-pre-wrap break-words text-on-surface">{suggestion.text}</div>
      <div className="flex flex-wrap gap-2">
        {onSend && (
          <button type="button" onClick={guard(onSend)} className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-on-primary">
            <Send className="h-3.5 w-3.5" aria-hidden /> {busy ? 'Send as guidance' : 'Send'}
          </button>
        )}
        {onEdit && <button type="button" onClick={guard(onEdit)} className="rounded-md border border-outline px-2 py-1">Edit in composer</button>}
        <button type="button" onClick={onDismiss} className="rounded-md px-2 py-1 text-on-surface-variant">Dismiss</button>
      </div>
    </div>
  );
}
