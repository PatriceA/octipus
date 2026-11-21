'use client';

import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Repeat } from 'lucide-react';
import type { CalendarEvent } from '../../../src/shared/calendar';
import { instantAt, layoutAllDay, layoutDay, noonOf, segmentsForDay, snapMinutes } from '../../../src/shared/calendar-layout';
import { clock, colorOf, eventKey, hourLabel, type NewEventSeed, timeLabel, tint } from './model';

/** Height of one hour, in px. */
const HOUR = 48;
const GUTTER = 56;
const DAY_MIN = 24 * 60;
/** Pointer travel before a press counts as a drag. */
const DRAG_PX = 5;

const toPx = (minutes: number) => (minutes / 60) * HOUR;
const range = (startMin: number, endMin: number) => `${clock(new Date(2000, 0, 1, 0, startMin))} – ${clock(new Date(2000, 0, 1, 0, endMin))}`;

/** How an event block looks: its calendar's colour, and its state by shape as well as colour. */
export function eventStyle(event: CalendarEvent, past = false): { style: CSSProperties; className: string } {
  const color = colorOf(event);
  const declined = event.responseStatus === 'declined';
  const open = event.responseStatus === 'tentative' || event.responseStatus === 'needsAction';
  return {
    style: {
      background: declined ? 'transparent' : tint(color, open ? 8 : 18),
      borderLeft: `3px ${open ? 'dashed' : 'solid'} ${color}`,
      ...(declined ? { outline: `1px dashed ${tint(color, 60)}`, outlineOffset: -1 } : {}),
    },
    className: `${declined ? 'line-through text-on-surface-variant' : 'text-on-surface'} ${past && !declined ? 'opacity-75' : ''}`,
  };
}

interface Props {
  days: string[];
  events: CalendarEvent[];
  /** Nothing has loaded yet: show the grid with placeholders. */
  loading: boolean;
  today: string;
  /** Minutes since local midnight, for the "now" line. */
  nowMin: number;
  selectedKey?: string;
  onSelect: (event: CalendarEvent, anchor: DOMRect) => void;
  onCreate: (seed: NewEventSeed) => void;
  onMove: (event: CalendarEvent, start: string, end: string) => void;
  onOpenDay: (day: string) => void;
}

interface Draft { day: string; startMin: number; endMin: number }
interface Ghost extends Draft { key: string }

export function TimeGrid({ days, events, loading, today, nowMin, selectedKey, onSelect, onCreate, onMove, onOpenDay }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const columns = useRef(new Map<string, HTMLDivElement>());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const creating = useRef<{ day: string; anchorMin: number; y: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);

  // Open on the working day, not on midnight.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = toPx(Math.max(0, Math.min(nowMin - 120, 7 * 60)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the grid appears
  }, []);

  const perDay = useMemo(() => new Map(days.map((day) => [day, layoutDay(segmentsForDay(events, day))])), [days, events]);
  const spans = useMemo(() => layoutAllDay(events, days), [days, events]);
  const laneRows = Math.max(1, ...spans.map((s) => s.row + 1));
  const template = `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`;
  const minuteAt = (day: string, clientY: number) => {
    const column = columns.current.get(day);
    return column ? ((clientY - column.getBoundingClientRect().top) / HOUR) * 60 : 0;
  };

  // ── Create: click an empty slot for an hour, or drag out a range ──────────
  const startCreate = (day: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    creating.current = { day, anchorMin: minuteAt(day, e.clientY), y: e.clientY, moved: false };
    if (e.pointerType !== 'touch') e.currentTarget.setPointerCapture(e.pointerId);
  };
  const dragCreate = (e: ReactPointerEvent<HTMLDivElement>) => {
    const c = creating.current;
    if (!c) return;
    if (Math.abs(e.clientY - c.y) > DRAG_PX) c.moved = true;
    if (!c.moved) return;
    const at = minuteAt(c.day, e.clientY);
    const startMin = snapMinutes(Math.min(c.anchorMin, at));
    setDraft({ day: c.day, startMin, endMin: Math.max(snapMinutes(Math.max(c.anchorMin, at)), startMin + 15) });
  };
  const endCreate = () => {
    const c = creating.current;
    creating.current = null;
    if (!c) return;
    if (c.moved && draft) onCreate({ day: draft.day, startMin: draft.startMin, endMin: draft.endMin });
    else {
      const startMin = Math.min(Math.floor(c.anchorMin / 30) * 30, DAY_MIN - 60);
      onCreate({ day: c.day, startMin: Math.max(0, startMin), endMin: Math.max(0, startMin) + 60 });
    }
    setDraft(null);
  };

  // ── Move: drag an event to another time or day ────────────────────────────
  const ghostRef = useRef<Ghost | null>(null);
  const startMove = (event: CalendarEvent, day: string, startMin: number, endMin: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || e.pointerType === 'touch' || event.readOnly) return;
    const origin = { x: e.clientX, y: e.clientY };
    const grab = minuteAt(day, e.clientY) - startMin;
    const length = endMin - startMin;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) <= DRAG_PX) return;
      moved = true;
      // The day whose column the pointer is over; outside the grid, the nearest one.
      let target = day;
      let best = Infinity;
      for (const [d, el] of columns.current) {
        const rect = el.getBoundingClientRect();
        const distance = ev.clientX < rect.left ? rect.left - ev.clientX : ev.clientX > rect.right ? ev.clientX - rect.right : 0;
        if (distance < best) { best = distance; target = d; }
      }
      const start = Math.max(0, Math.min(DAY_MIN - 15, snapMinutes(minuteAt(target, ev.clientY) - grab)));
      ghostRef.current = { key: eventKey(event), day: target, startMin: start, endMin: Math.min(DAY_MIN, start + length) };
      setGhost(ghostRef.current);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const g = ghostRef.current;
      ghostRef.current = null;
      setGhost(null);
      if (!moved) return;
      // The click that follows a drag must not open the event.
      justDragged.current = true;
      setTimeout(() => { justDragged.current = false; }, 0);
      if (!g || (g.day === day && g.startMin === startMin)) return;
      const start = instantAt(g.day, g.startMin);
      const duration = event.end ? Date.parse(event.end) - Date.parse(event.start) : 60 * 60_000;
      onMove(event, start, new Date(Date.parse(start) + duration).toISOString());
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    abandonMove.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  };

  // A drag left unfinished when the grid goes away must not leave listeners behind.
  const abandonMove = useRef<(() => void) | null>(null);
  useEffect(() => () => abandonMove.current?.(), []);

  return (
    <div ref={scroller} data-testid="time-grid" className="h-full overflow-auto rounded-md border border-outline-variant/60 bg-surface">
      <div style={{ minWidth: days.length > 1 ? 640 : undefined }}>
        <div className="sticky top-0 z-20 bg-surface border-b border-outline-variant/60">
          <div className="grid" style={{ gridTemplateColumns: template }}>
            <div />
            {days.map((day) => {
              const date = noonOf(day);
              const isToday = day === today;
              return (
                <button key={day} onClick={() => onOpenDay(day)} title="Open this day" aria-current={isToday ? 'date' : undefined}
                  className="py-1.5 border-l border-outline-variant/40 flex items-center justify-center gap-1.5 hover:bg-surface-container-low cursor-pointer">
                  <span className={`text-xs uppercase tracking-wide ${isToday ? 'text-primary font-semibold' : 'text-on-surface-variant'}`}>{date.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                  <span className={`text-sm font-semibold min-w-6 h-6 px-1 inline-flex items-center justify-center rounded-full ${isToday ? 'bg-primary text-on-primary' : 'text-on-surface'}`}>{date.getDate()}</span>
                </button>
              );
            })}
          </div>
          {/* All-day lane */}
          <div className="grid border-t border-outline-variant/40" style={{ gridTemplateColumns: template }}>
            <div className="text-[10px] text-on-surface-variant text-right pr-1.5 pt-1">all day</div>
            <div className="grid gap-y-0.5 py-0.5 max-h-28 overflow-y-auto" style={{ gridColumn: `2 / span ${days.length}`, gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${laneRows}, 22px)` }}>
              {days.map((day, i) => (
                <button key={day} aria-label={`New all-day event on ${noonOf(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`}
                  onClick={() => onCreate({ day, allDay: true })}
                  className="border-l border-outline-variant/40 hover:bg-surface-container-low cursor-pointer" style={{ gridColumn: i + 1, gridRow: `1 / span ${laneRows}` }} />
              ))}
              {spans.map((span) => {
                const look = eventStyle(span.event);
                return (
                  <button key={eventKey(span.event)} onClick={(e) => onSelect(span.event, e.currentTarget.getBoundingClientRect())}
                    aria-label={`${span.event.title}, ${timeLabel(span.event)}`}
                    className={`z-10 mx-0.5 px-1.5 text-xs text-left truncate rounded-xs cursor-pointer ${look.className} ${selectedKey === eventKey(span.event) ? 'ring-2 ring-primary' : ''}`}
                    style={{ ...look.style, gridColumn: `${span.start + 1} / span ${span.length}`, gridRow: span.row + 1 }}>
                    {span.continuesBefore ? '‹ ' : ''}{span.event.title}{span.continuesAfter ? ' ›' : ''}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid relative" style={{ gridTemplateColumns: template, height: toPx(DAY_MIN) }}>
          <div className="relative" aria-hidden>
            {Array.from({ length: 23 }, (_, i) => i + 1).map((hour) => (
              <span key={hour} className="absolute right-1.5 text-[10px] text-on-surface-variant tabular-nums" style={{ top: toPx(hour * 60) - 7 }}>{hourLabel(hour)}</span>
            ))}
          </div>
          {days.map((day) => {
            const isPast = day < today;
            return (
              <div key={day} ref={(el) => { if (el) columns.current.set(day, el); else columns.current.delete(day); }}
                data-day={day} role="group" aria-label={noonOf(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
                onPointerDown={startCreate(day)} onPointerMove={dragCreate} onPointerUp={endCreate} onPointerCancel={() => { creating.current = null; setDraft(null); }}
                className={`relative border-l border-outline-variant/40 cursor-cell select-none ${day === today ? 'bg-primary-container/15' : ''}`}
                style={{ backgroundImage: 'linear-gradient(to bottom, color-mix(in srgb, var(--color-outline-variant) 55%, transparent) 1px, transparent 1px)', backgroundSize: `100% ${HOUR}px` }}>
                {loading && SKELETON.map(([startMin, endMin], i) => (
                  <div key={i} className="absolute left-1 right-1 rounded-xs bg-surface-container-highest animate-pulse pointer-events-none" style={{ top: toPx(startMin + (day.charCodeAt(9) % 3) * 30), height: toPx(endMin - startMin) - 2 }} />
                ))}
                {(perDay.get(day) ?? []).map((item) => {
                  const key = eventKey(item.event);
                  const dragging = ghost?.key === key;
                  const height = Math.max(toPx(item.endMin - item.startMin) - 2, 18);
                  const look = eventStyle(item.event, isPast || (day === today && item.endMin < nowMin));
                  const movable = !item.event.readOnly && !item.continuesBefore && !item.continuesAfter;
                  return (
                    <button key={key} data-event={key}
                      onPointerDown={movable ? startMove(item.event, day, item.startMin, item.endMin) : undefined}
                      onClick={(e) => { if (!justDragged.current) onSelect(item.event, e.currentTarget.getBoundingClientRect()); }}
                      aria-label={`${item.event.title}, ${timeLabel(item.event)}`}
                      className={`absolute z-10 overflow-hidden rounded-xs px-1.5 py-0.5 text-left text-xs leading-tight cursor-pointer hover:brightness-95 ${look.className} ${selectedKey === key ? 'ring-2 ring-primary' : ''} ${dragging ? 'opacity-40' : ''}`}
                      style={{ ...look.style, top: toPx(item.startMin) + 1, height, left: `calc(${(item.column / item.columns) * 100}% + 2px)`, width: `calc(${(item.span / item.columns) * 100}% - 4px)` }}>
                      <span className="block font-medium truncate">
                        {item.event.recurring && <Repeat className="inline w-3 h-3 mr-1 -mt-0.5 opacity-70" aria-hidden />}
                        {item.event.title}
                      </span>
                      {height >= 34 && <span className="block truncate text-[11px] opacity-80">{timeLabel(item.event)}</span>}
                      {height >= 52 && item.event.location && <span className="block truncate text-[11px] opacity-70">{item.event.location}</span>}
                    </button>
                  );
                })}
                {draft?.day === day && <Preview startMin={draft.startMin} endMin={draft.endMin} label="New event" />}
                {ghost?.day === day && <Preview startMin={ghost.startMin} endMin={ghost.endMin} label="Move here" />}
                {day === today && (
                  <div data-testid="now-line" className="absolute left-0 right-0 z-10 pointer-events-none" style={{ top: toPx(nowMin) }} aria-hidden>
                    <div className="h-0.5 bg-error" />
                    <div className="absolute -left-1 -top-[3px] w-2 h-2 rounded-full bg-error" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Placeholder blocks while the first range loads: the page already has its shape. */
const SKELETON: ReadonlyArray<readonly [number, number]> = [[9 * 60, 10 * 60], [11 * 60 + 30, 12 * 60 + 30], [14 * 60, 15 * 60 + 30]];

function Preview({ startMin, endMin, label }: { startMin: number; endMin: number; label: string }) {
  return (
    <div className="absolute left-0.5 right-0.5 z-20 rounded-xs border-2 border-dashed border-primary bg-primary-container/40 px-1.5 py-0.5 text-[11px] text-on-surface pointer-events-none"
      style={{ top: toPx(startMin), height: Math.max(toPx(endMin - startMin), 16) }}>
      {label} · {range(startMin, endMin)}
    </div>
  );
}
