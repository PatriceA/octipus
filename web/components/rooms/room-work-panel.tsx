'use client';

import Link from 'next/link';
import { splitInlineUiSegments, inlineUiFallbackText } from '../../../src/shared/inline-ui/fence';
import { CompanionAvatar } from '@/components/companion/companion-avatar';
import type { RoomMessage } from '@/lib/rooms';

/** An index of public conversation rows, never private tool events or draft output. */
export function RoomWorkPanel({ messages, onReveal, hasOlder, onLoadOlder }: {
  messages: RoomMessage[]; onReveal: (messageId: string) => void; hasOlder: boolean; onLoadOlder: () => void;
}) {
  const answers = messages.filter(m => m.role === 'assistant' && m.metadata.kind !== 'progress').reverse();
  const updates = messages.filter(m => m.role === 'assistant' && m.metadata.kind === 'progress').slice(-6).reverse();
  const outputs = new Map<string, { title: string; message: RoomMessage }>();
  for (const message of answers) {
    for (const segment of splitInlineUiSegments(message.content)) {
      if (segment.kind === 'block' && !outputs.has(segment.id)) outputs.set(segment.id, { title: segment.title, message });
    }
  }
  const owner = (message: RoomMessage) => message.metadata.companion
    ? `${message.metadata.companion.name} · ${message.metadata.companion.ownerName}’s companion` : 'Octipus';
  const excerpt = (message: RoomMessage) => inlineUiFallbackText(message.content).replace(/\s+/g, ' ').slice(0, 180);

  return (
    <div className="space-y-6 text-xs" data-testid="room-work-panel">
      <div>
        <h2 className="text-sm font-medium text-on-surface">Work from this conversation</h2>
        <p className="mt-2 text-on-surface-variant">Shared updates, answers, and interactive outputs stay with the discussion. Open any item to return to its message.</p>
      </div>
      <section aria-label="Interactive outputs">
        <h3 className="mb-2 text-on-surface font-medium">Interactive outputs · {outputs.size}</h3>
        {outputs.size === 0 ? <p className="text-on-surface-variant">Prototypes and other interactive answers appear here when a companion shares them.</p> : (
          <ul className="space-y-2">
            {[...outputs].map(([id, { title, message }]) => (
              <li key={id}>
                <button type="button" onClick={() => onReveal(message.id)} className="w-full rounded-lg border border-primary/30 bg-primary-container/10 p-3 text-left hover:border-primary">
                  <span className="block font-medium text-on-surface">{title}</span>
                  <span className="mt-1 block text-on-surface-variant">{owner(message)}</span>
                  <span className="mt-2 block text-primary">Open in conversation →</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Public progress updates">
        <h3 className="mb-2 text-on-surface font-medium">Recent updates</h3>
        {updates.length === 0 ? <p className="text-on-surface-variant">Public progress updates will appear here as work moves forward.</p> : (
          <ul className="space-y-3">
            {updates.map(message => (
              <li key={message.id}>
                <button type="button" onClick={() => onReveal(message.id)} className="w-full border-l-2 border-primary/30 pl-3 text-left hover:text-primary">
                  <span className="block text-on-surface-variant">{owner(message)}</span>
                  <span className="mt-1 block break-words">{excerpt(message)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Shared replies">
        <h3 className="mb-2 text-on-surface font-medium">Recent replies</h3>
        {answers.length === 0 ? <p className="text-on-surface-variant">Use the composer to explore an idea, research a question, or ask for a prototype. You can edit the request before posting.</p> : (
          <ul className="space-y-2">
            {answers.slice(0, 8).map(message => (
              <li key={message.id}>
                <button type="button" onClick={() => onReveal(message.id)} className="flex w-full gap-2 rounded-lg border border-outline-variant/40 p-2 text-left hover:border-primary">
                  <CompanionAvatar size={28} appearance={message.metadata.companion?.appearance} />
                  <span className="min-w-0">
                    <span className="block text-on-surface-variant">{owner(message)}</span>
                    <span className="mt-1 block break-words">{excerpt(message)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="border-t border-outline-variant/40 pt-4 space-y-2">
        <p className="text-on-surface-variant">Keep track of agreed follow-ups on the task board. This panel indexes only this room’s conversation.</p>
        <Link href="/tasks" className="inline-block text-primary underline underline-offset-4">Open next steps →</Link>
      </div>
      {hasOlder && <button type="button" onClick={onLoadOlder} className="text-primary underline">Load earlier conversation work</button>}
    </div>
  );
}
