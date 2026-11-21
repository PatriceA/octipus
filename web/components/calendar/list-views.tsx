'use client';

import { MapPin, Repeat, Video } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import type { CalendarEvent } from '../../../src/shared/calendar';
import { daysBetween, durationOf, minutesInto, shiftAllDay } from '../../../src/shared/calendar-free';
import { instantAt, noonOf, onDay } from '../../../src/shared/calendar-layout';
import { beginDrag } from './drag';
import { clock, colorOf, eventKey, type NewEventSeed, timeLabel } from './model';
import { eventStyle } from './time-grid';

interface Common {
  events: CalendarEvent[];
  loading: boolean;
  today: string;
  selectedKey?: string;
  onSelect: (event: CalendarEvent, anchor: DOMRect) => void;
  onCreate: (seed: NewEventSeed) => void;
  onOpenDay: (day: string) => void;
}

/** All-day events first, then by start. */
const eventsOn = (events: CalendarEvent[], day: string) =>
  events.filter((e) => onDay(e, day)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));

/** How many events a month cell lists before "+n more". */
const MONTH_CELL_EVENTS = 3;

/** The month cell under a point, by its `data-day`. */
function dayAt(grid: HTMLElement | null, x: number, y: number): string | null {
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-day]');
  return hit && grid?.contains(hit) ? hit.dataset.day ?? null : null;
}

/**
 * An event moved from one day to another: an all-day one by whole days, a
 * timed one to the same clock time on the new day, its length kept.
 */
export function movedToDay(event: CalendarEvent, from: string, to: string): { start: string; end: string } {
  if (event.allDay) return shiftAllDay(event, daysBetween(from, to));
  const start = instantAt(to, minutesInto(from, event.start));
  return { start, end: new Date(Date.parse(start) + durationOf(event) * 60_000).toISOString() };
}

export function MonthView({ days, month, events, loading, today, selectedKey, onSelect, onCreate, onOpenDay, onMove }: Common & { days: string[]; month: string; onMove?: (event: CalendarEvent, start: string, end: string) => void }) {
  const grid = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ key: string; day: string } | null>(null);
  const targetRef = useRef<{ key: string; day: string } | null>(null);
  const justDragged = useRef(false);
  const abandon = useRef<(() => void) | null>(null);
  useEffect(() => () => abandon.current?.(), []);

  /** Drag an event to another day of the month. */
  const startMove = (event: CalendarEvent, day: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!onMove || e.button !== 0 || event.readOnly) return;
    const key = eventKey(event);
    abandon.current?.();
    abandon.current = beginDrag(e, {
      onMove: (ev) => {
        const over = dayAt(grid.current, ev.clientX, ev.clientY);
        targetRef.current = over ? { key, day: over } : null;
        setTarget(targetRef.current);
      },
      onEnd: (dropped) => {
        const to = targetRef.current?.day;
        targetRef.current = null;
        setTarget(null);
        if (!dropped) return;
        justDragged.current = true;
        setTimeout(() => { justDragged.current = false; }, 0);
        // The day the event was grabbed on stands for its first day: a multi-day event moves as a whole.
        if (!to || to === day) return;
        const { start, end } = movedToDay(event, day, to);
        onMove(event, start, end);
      },
    });
  };

  return (
    <div data-testid="month-grid" className="h-full flex flex-col rounded-md border border-outline-variant/60 bg-surface overflow-hidden">
      <div className="grid grid-cols-7 border-b border-outline-variant/60">
        {days.slice(0, 7).map((day) => (
          <div key={day} className="py-1.5 text-center text-xs uppercase tracking-wide text-on-surface-variant">{noonOf(day).toLocaleDateString(undefined, { weekday: 'short' })}</div>
        ))}
      </div>
      <div ref={grid} className="grid grid-cols-7 grid-rows-6 flex-1 min-h-0">
        {days.map((day, i) => {
          const list = eventsOn(events, day);
          const outside = day.slice(0, 7) !== month.slice(0, 7);
          const isToday = day === today;
          return (
            <div key={day} data-day={day} className={`relative min-h-0 overflow-hidden p-1 flex flex-col gap-0.5 ${i % 7 ? 'border-l' : ''} ${i >= 7 ? 'border-t' : ''} border-outline-variant/40 ${outside ? 'bg-surface-container-low' : ''} ${target?.day === day ? 'outline-2 -outline-offset-2 outline-dashed outline-primary bg-primary-container/30' : ''}`}>
              {/* The whole cell makes a new event; the things in it sit above. */}
              <button aria-label={`New event on ${noonOf(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`} onClick={() => onCreate({ day })} className="absolute inset-0 hover:bg-surface-container-high/50 cursor-cell" />
              <button onClick={() => onOpenDay(day)} title="Open this day" aria-current={isToday ? 'date' : undefined}
                className={`relative self-start text-xs font-semibold min-w-6 h-6 px-1 rounded-full inline-flex items-center justify-center cursor-pointer hover:bg-surface-container-highest ${isToday ? 'bg-primary text-on-primary hover:bg-primary' : outside ? 'text-on-surface-variant/70' : 'text-on-surface'}`}>
                {noonOf(day).getDate()}
              </button>
              {loading && i % 3 === 0 && <div className="relative h-4 rounded-xs bg-surface-container-highest animate-pulse" />}
              {list.slice(0, MONTH_CELL_EVENTS).map((event) => {
                const look = eventStyle(event, day < today);
                return (
                  <button key={eventKey(event)} data-event={eventKey(event)}
                    onPointerDown={startMove(event, day)}
                    onClick={(e) => { if (!justDragged.current) onSelect(event, e.currentTarget.getBoundingClientRect()); }}
                    onContextMenu={(e) => e.preventDefault()}
                    aria-label={`${event.title}, ${timeLabel(event)}`}
                    className={`relative shrink-0 w-full truncate rounded-xs px-1 text-left text-[11px] leading-[18px] cursor-pointer select-none [-webkit-touch-callout:none] hover:brightness-95 ${look.className} ${selectedKey === eventKey(event) ? 'ring-2 ring-primary' : ''} ${target?.key === eventKey(event) ? 'opacity-50' : ''}`} style={look.style}>
                    {!event.allDay && <span className="tabular-nums opacity-70 mr-1">{clock(new Date(event.start))}</span>}{event.title}
                  </button>
                );
              })}
              {list.length > MONTH_CELL_EVENTS && (
                <button onClick={() => onOpenDay(day)} className="relative self-start text-[11px] text-on-surface-variant hover:text-on-surface hover:underline cursor-pointer px-1">+{list.length - MONTH_CELL_EVENTS} more</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AgendaView({ days, events, loading, today, selectedKey, onSelect, onCreate, onOpenDay }: Common & { days: string[] }) {
  const filled = days.map((day) => ({ day, list: eventsOn(events, day) })).filter((d) => d.list.length > 0 || d.day === today);
  return (
    <div data-testid="agenda" className="h-full overflow-y-auto rounded-md border border-outline-variant/60 bg-surface">
      {loading && Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex gap-3 px-4 py-3 border-b border-outline-variant/30"><div className="h-4 w-20 rounded-xs bg-surface-container-highest animate-pulse" /><div className="h-4 flex-1 rounded-xs bg-surface-container-highest animate-pulse" /></div>
      ))}
      {!loading && filled.every((d) => d.list.length === 0) && <p className="px-4 py-10 text-center text-sm text-on-surface-variant">Nothing scheduled in these two weeks.</p>}
      {!loading && filled.map(({ day, list }) => (
        <section key={day} className="flex flex-col sm:flex-row border-b border-outline-variant/30 last:border-b-0">
          <button onClick={() => onOpenDay(day)} title="Open this day" className={`sm:w-40 shrink-0 px-4 pt-3 pb-1 sm:pb-3 text-left text-sm cursor-pointer hover:underline ${day === today ? 'text-primary font-semibold' : 'text-on-surface-variant'}`}>
            {day === today ? 'Today · ' : ''}{noonOf(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
          </button>
          <div className="flex-1 min-w-0 py-1.5 pr-2">
            {list.length === 0 && <button onClick={() => onCreate({ day })} className="px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface cursor-pointer">Nothing scheduled. Add an event</button>}
            {list.map((event) => {
              const declined = event.responseStatus === 'declined';
              return (
                <button key={eventKey(event)} onClick={(e) => onSelect(event, e.currentTarget.getBoundingClientRect())}
                  className={`w-full flex items-start gap-3 px-3 py-1.5 rounded-xs text-left cursor-pointer hover:bg-surface-container-high ${selectedKey === eventKey(event) ? 'bg-primary-container/30' : ''} ${day < today ? 'opacity-60' : ''}`}>
                  <span className="mt-1.5 w-2.5 h-2.5 rounded-full shrink-0" style={{ background: declined ? 'transparent' : colorOf(event), border: `2px solid ${colorOf(event)}` }} aria-hidden />
                  <span className="w-28 shrink-0 text-sm tabular-nums text-on-surface-variant">{event.allDay ? 'All day' : timeLabel(event)}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm truncate ${declined ? 'line-through text-on-surface-variant' : 'text-on-surface font-medium'}`}>
                      {event.recurring && <Repeat className="inline w-3 h-3 mr-1 -mt-0.5 opacity-70" aria-hidden />}{event.title}
                    </span>
                    <span className="flex flex-wrap gap-x-3 text-xs text-on-surface-variant">
                      {event.calendarName && <span className="truncate">{event.calendarName}</span>}
                      {event.location && <span className="inline-flex items-center gap-1 truncate"><MapPin className="w-3 h-3" aria-hidden />{event.location}</span>}
                      {event.meetingUrl && <span className="inline-flex items-center gap-1"><Video className="w-3 h-3" aria-hidden />Online</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
