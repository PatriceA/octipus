'use client';

import { CalendarDays, Check, ExternalLink, HelpCircle, Lock, MapPin, Pencil, Repeat, Trash2, Users, Video, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Portal } from '@/components/ui/portal';
import type { CalendarEvent, CalendarResponse } from '../../../src/shared/calendar';
import { buttonDanger, buttonPrimary, buttonQuiet, colorOf, providerName, RESPONSE_LABEL, whenLabel } from './model';

type Answer = Exclude<CalendarResponse, 'needsAction'>;
const ANSWERS: ReadonlyArray<{ id: Answer; label: string }> = [{ id: 'accepted', label: 'Accept' }, { id: 'tentative', label: 'Maybe' }, { id: 'declined', label: 'Decline' }];
const WIDTH = 340;

interface Props {
  event: CalendarEvent;
  /** The block that was pressed: the card opens beside it. */
  anchor: DOMRect;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  /** `all`: every event of the series this occurrence belongs to. */
  onDelete: (scope: 'this' | 'all') => void;
  onRespond: (response: Answer) => void;
}

export function EventPopover({ event, anchor, busy, onClose, onEdit, onDelete, onRespond }: Props) {
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const guests = event.attendees.length;

  // Beside the block where there is room, else over it; always inside the window.
  useLayoutEffect(() => {
    const height = card.current?.offsetHeight ?? 320;
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = Math.min(WIDTH, vw - 16);
    let left = anchor.right + 8;
    if (left + width > vw - 8) left = anchor.left - width - 8;
    if (left < 8) left = Math.max(8, Math.min(anchor.left, vw - width - 8));
    setPlace({ left, top: Math.max(8, Math.min(anchor.top, vh - height - 8)) });
  }, [anchor, event, confirmDelete]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const press = (e: PointerEvent) => { if (card.current && !card.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('keydown', key);
    // After this press has finished, or the press that opened the card would close it.
    const timer = setTimeout(() => document.addEventListener('pointerdown', press), 0);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', press); };
  }, [onClose]);

  useEffect(() => { card.current?.focus(); }, []);

  const color = colorOf(event);
  return (
    <Portal>
      <div ref={card} role="dialog" aria-label={event.title} tabIndex={-1}
        className="fixed z-40 rounded-lg border border-outline-variant bg-surface-container shadow-xl font-sans outline-none max-h-[calc(100vh-16px)] overflow-y-auto"
        style={{ width: `min(${WIDTH}px, calc(100vw - 16px))`, left: place?.left ?? -9999, top: place?.top ?? 0, visibility: place ? 'visible' : 'hidden' }}>
        <div className="h-1.5 rounded-t-lg" style={{ background: color }} />
        <div className="p-4 space-y-3">
          <div className="flex items-start gap-2">
            <h2 className={`flex-1 min-w-0 text-base font-semibold break-words ${event.responseStatus === 'declined' ? 'line-through text-on-surface-variant' : 'text-on-surface'}`}>{event.title}</h2>
            <button onClick={onClose} aria-label="Close" className="p-1 -m-1 text-on-surface-variant hover:text-on-surface cursor-pointer"><X className="w-4 h-4" /></button>
          </div>

          <div className="space-y-1.5 text-sm text-on-surface">
            <p>{whenLabel(event)}</p>
            {event.recurring && <p className="flex items-center gap-1.5 text-on-surface-variant"><Repeat className="w-3.5 h-3.5 shrink-0" aria-hidden />Repeats. You choose whether a change reaches this event or the whole series.</p>}
            <p className="flex items-center gap-1.5 text-on-surface-variant">
              <CalendarDays className="w-3.5 h-3.5 shrink-0" aria-hidden />
              <span className="truncate">{event.calendarName ?? 'Calendar'} · {providerName(event.provider)}</span>
              {event.readOnly && <span className="inline-flex items-center gap-1 shrink-0"><Lock className="w-3 h-3" aria-hidden />read-only</span>}
            </p>
            {event.location && <p className="flex items-start gap-1.5 text-on-surface-variant"><MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden /><span className="break-words min-w-0">{event.location}</span></p>}
            {event.showAs && event.showAs !== 'busy' && <p className="text-on-surface-variant">Shows you as {event.showAs === 'away' ? 'away' : event.showAs === 'free' ? 'free' : 'maybe busy'}.</p>}
          </div>

          {event.meetingUrl && (
            <a href={event.meetingUrl} target="_blank" rel="noreferrer noopener" className={`${buttonPrimary} no-underline`}><Video className="w-4 h-4" aria-hidden />Join meeting</a>
          )}

          {event.description && <p className="text-sm text-on-surface whitespace-pre-wrap break-words max-h-32 overflow-y-auto border-t border-outline-variant/40 pt-2">{event.description}</p>}

          {guests > 0 && (
            <div className="border-t border-outline-variant/40 pt-2">
              <p className="flex items-center gap-1.5 text-xs text-on-surface-variant mb-1"><Users className="w-3.5 h-3.5" aria-hidden />{guests} {guests === 1 ? 'guest' : 'guests'}</p>
              <ul className="max-h-28 overflow-y-auto space-y-0.5">
                {event.attendees.map((a, i) => (
                  <li key={`${a.email ?? a.name}-${i}`} className="flex items-center gap-1.5 text-sm text-on-surface">
                    <ResponseMark response={a.response} />
                    <span className={`truncate ${a.response === 'declined' ? 'line-through text-on-surface-variant' : ''}`} title={a.email}>{a.name || a.email}</span>
                    {a.response && <span className="sr-only">({RESPONSE_LABEL[a.response]})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {event.responseStatus && (
            <div className="border-t border-outline-variant/40 pt-2">
              <p className="text-xs text-on-surface-variant mb-1.5">Your answer: {RESPONSE_LABEL[event.responseStatus]}</p>
              <div className="flex gap-1.5" role="group" aria-label="Answer the invitation">
                {ANSWERS.map((answer) => (
                  <button key={answer.id} disabled={busy} aria-pressed={event.responseStatus === answer.id} onClick={() => onRespond(answer.id)}
                    className={`${buttonQuiet} ${event.responseStatus === answer.id ? 'border-primary bg-primary-container/40 font-semibold' : ''}`}>{answer.label}</button>
                ))}
              </div>
            </div>
          )}

          {confirmDelete ? (
            <div role="alertdialog" aria-label="Delete event" className="border-t border-outline-variant/40 pt-3 space-y-2">
              <p className="text-sm text-on-surface">
                Delete “{event.title}”{event.recurring ? ': only this event, or every event of the series?' : '?'}
                {guests > 0 && <> Its {guests === 1 ? 'guest' : `${guests} guests`} will be told it is cancelled.</>}
              </p>
              <div className="flex flex-wrap gap-2">
                {event.recurring ? (
                  <>
                    <button disabled={busy} onClick={() => onDelete('this')} className={buttonDanger}><Trash2 className="w-3.5 h-3.5" aria-hidden />This event</button>
                    <button disabled={busy} onClick={() => onDelete('all')} className={buttonDanger}>All events</button>
                  </>
                ) : (
                  <button disabled={busy} onClick={() => onDelete('this')} className={buttonDanger}><Trash2 className="w-3.5 h-3.5" aria-hidden />{guests > 0 ? 'Delete and notify' : 'Delete event'}</button>
                )}
                <button disabled={busy} onClick={() => setConfirmDelete(false)} className={buttonQuiet}>Keep it</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant/40 pt-3">
              {!event.readOnly && <button disabled={busy} onClick={onEdit} className={buttonQuiet}><Pencil className="w-3.5 h-3.5" aria-hidden />Edit</button>}
              {!event.readOnly && <button disabled={busy} onClick={() => setConfirmDelete(true)} className={buttonQuiet}><Trash2 className="w-3.5 h-3.5" aria-hidden />Delete</button>}
              {event.webUrl && <a href={event.webUrl} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface">Open in {providerName(event.provider)}<ExternalLink className="w-3 h-3" aria-hidden /></a>}
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}

function ResponseMark({ response }: { response?: CalendarResponse }) {
  if (response === 'accepted') return <Check className="w-3.5 h-3.5 text-tertiary shrink-0" aria-hidden />;
  if (response === 'declined') return <X className="w-3.5 h-3.5 text-error shrink-0" aria-hidden />;
  return <HelpCircle className="w-3.5 h-3.5 text-on-surface-variant shrink-0" aria-hidden />;
}
