'use client';

import { Calendar, Clock, Repeat } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

// ── Types ──────────────────────────────────────────────────────────

type ScheduleMode = 'preset' | 'interval' | 'daily' | 'weekly' | 'cron' | 'datetime';

interface Preset {
  label: string;
  cron: string;
  description: string;
}

interface SchedulePickerProps {
  value: string;                   // cron expression or @datetime:ISO string
  onChange: (cron: string) => void;
  onScheduledAtChange?: (scheduledAt: string | null) => void;
  scheduledAt?: string | null;     // ISO datetime for one-time tasks
  className?: string;
}

// ── Presets ─────────────────────────────────────────────────────────

const PRESETS: Preset[] = [
  { label: 'Every 15 minutes',   cron: '*/15 * * * *', description: 'Runs 4 times per hour' },
  { label: 'Every 30 minutes',   cron: '*/30 * * * *', description: 'Runs twice per hour' },
  { label: 'Every hour',         cron: '0 * * * *',    description: 'At the top of every hour' },
  { label: 'Every 3 hours',      cron: '0 */3 * * *',  description: '8 times per day' },
  { label: 'Every 6 hours',      cron: '0 */6 * * *',  description: '4 times per day' },
  { label: 'Every day at 9 AM',  cron: '0 9 * * *',    description: 'Once daily, morning' },
  { label: 'Every day at noon',  cron: '0 12 * * *',   description: 'Once daily, midday' },
  { label: 'Every day at 6 PM',  cron: '0 18 * * *',   description: 'Once daily, evening' },
  { label: 'Weekdays at 9 AM',   cron: '0 9 * * 1-5',  description: 'Mon–Fri, morning' },
  { label: 'Every Monday at 9 AM', cron: '0 9 * * 1',  description: 'Weekly on Monday' },
];

const DAYS_OF_WEEK = [
  { value: 1, short: 'Mon', label: 'Monday' },
  { value: 2, short: 'Tue', label: 'Tuesday' },
  { value: 3, short: 'Wed', label: 'Wednesday' },
  { value: 4, short: 'Thu', label: 'Thursday' },
  { value: 5, short: 'Fri', label: 'Friday' },
  { value: 6, short: 'Sat', label: 'Saturday' },
  { value: 0, short: 'Sun', label: 'Sunday' },
];

// ── Helpers ─────────────────────────────────────────────────────────

/** Parse an existing cron expression into a mode + state */
function parseCron(cron: string): {
  mode: ScheduleMode;
  intervalValue: number;
  intervalUnit: 'minutes' | 'hours';
  hour: number;
  minute: number;
  days: number[];
} {
  const defaults = { intervalValue: 30, intervalUnit: 'minutes' as const, hour: 9, minute: 0, days: [] as number[] };
  if (!cron) return { mode: 'preset', ...defaults };

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { mode: 'cron', ...defaults };

  const [minP, hourP, , , dowP] = parts;

  // Check for */N minute interval
  const minInterval = minP.match(/^\*\/(\d+)$/);
  if (minInterval && hourP === '*') {
    return { mode: 'interval', intervalValue: parseInt(minInterval[1]), intervalUnit: 'minutes', hour: 9, minute: 0, days: [] };
  }

  // Check for */N hour interval
  const hourInterval = hourP.match(/^\*\/(\d+)$/);
  if (hourInterval) {
    return { mode: 'interval', intervalValue: parseInt(hourInterval[1]), intervalUnit: 'hours', hour: 9, minute: parseInt(minP) || 0, days: [] };
  }

  // Fixed time
  const hour = hourP === '*' ? 0 : parseInt(hourP) || 0;
  const minute = minP === '*' ? 0 : parseInt(minP) || 0;

  // Parse days of week
  if (dowP !== '*') {
    const days = parseDayOfWeek(dowP);
    if (days.length > 0) {
      return { mode: 'weekly', intervalValue: 30, intervalUnit: 'minutes', hour, minute, days };
    }
  }

  // Check if it matches a preset
  const preset = PRESETS.find(p => p.cron === cron.trim());
  if (preset) {
    return { mode: 'preset', ...defaults, hour, minute };
  }

  // Daily at specific time
  if (hourP !== '*' && dowP === '*') {
    return { mode: 'daily', intervalValue: 30, intervalUnit: 'minutes', hour, minute, days: [] };
  }

  return { mode: 'cron', ...defaults };
}

function parseDayOfWeek(dow: string): number[] {
  const days: number[] = [];
  for (const part of dow.split(',')) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) {
      const start = parseInt(range[1]);
      const end = parseInt(range[2]);
      for (let i = start; i <= end; i++) days.push(i);
    } else {
      const num = parseInt(part);
      if (!isNaN(num)) days.push(num);
    }
  }
  return days;
}

function buildCron(
  mode: ScheduleMode,
  intervalValue: number,
  intervalUnit: 'minutes' | 'hours',
  hour: number,
  minute: number,
  days: number[],
  rawCron: string,
): string {
  switch (mode) {
    case 'interval':
      if (intervalUnit === 'minutes') return `*/${intervalValue} * * * *`;
      return `${minute} */${intervalValue} * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly': {
      const dowStr = days.length > 0 ? days.sort((a, b) => a - b).join(',') : '*';
      return `${minute} ${hour} * * ${dowStr}`;
    }
    case 'cron':
      return rawCron;
    default:
      return rawCron;
  }
}

export function describeCron(cron: string): string {
  if (!cron) return 'No schedule set';
  const preset = PRESETS.find(p => p.cron === cron.trim());
  if (preset) return preset.label;

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minP, hourP, , , dowP] = parts;

  const minInterval = minP.match(/^\*\/(\d+)$/);
  if (minInterval && hourP === '*') return `Every ${minInterval[1]} minutes`;

  const hourInterval = hourP.match(/^\*\/(\d+)$/);
  if (hourInterval) {
    const min = parseInt(minP) || 0;
    return `Every ${hourInterval[1]} hours` + (min > 0 ? ` at :${String(min).padStart(2, '0')}` : '');
  }

  const hour = hourP === '*' ? null : parseInt(hourP);
  const minute = minP === '*' ? 0 : parseInt(minP);
  const timeStr = hour !== null ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : null;

  if (dowP !== '*' && timeStr) {
    const days = parseDayOfWeek(dowP);
    const dayNames = days.map(d => DAYS_OF_WEEK.find(dw => dw.value === d)?.short || String(d));
    return `${dayNames.join(', ')} at ${timeStr}`;
  }

  if (timeStr && dowP === '*') return `Every day at ${timeStr}`;
  if (hourP === '*' && minP !== '*') return `Every hour at :${String(minute).padStart(2, '0')}`;

  return cron;
}

// ── Component ──────────────────────────────────────────────────────

export function SchedulePicker({ value, onChange, onScheduledAtChange, scheduledAt, className }: SchedulePickerProps) {
  const parsed = useMemo(() => parseCron(value), [value]);

  const [mode, setMode] = useState<ScheduleMode>(scheduledAt ? 'datetime' : parsed.mode);
  const [datetimeValue, setDatetimeValue] = useState(scheduledAt || '');
  const [intervalValue, setIntervalValue] = useState(parsed.intervalValue);
  const [intervalUnit, setIntervalUnit] = useState<'minutes' | 'hours'>(parsed.intervalUnit);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [days, setDays] = useState<number[]>(parsed.days);
  const [rawCron, setRawCron] = useState(value);

  // Emit onChange explicitly — never via useEffect to avoid tab-switching side effects
  const emitCron = (
    m: ScheduleMode,
    iv: number,
    iu: 'minutes' | 'hours',
    h: number,
    min: number,
    d: number[],
    rc: string,
  ) => {
    const cron = buildCron(m, iv, iu, h, min, d, rc);
    if (cron !== value) onChange(cron);
  };

  const handlePresetClick = (preset: Preset) => {
    setRawCron(preset.cron);
    onChange(preset.cron);
    const p = parseCron(preset.cron);
    setIntervalValue(p.intervalValue);
    setIntervalUnit(p.intervalUnit);
    setHour(p.hour);
    setMinute(p.minute);
    setDays(p.days);
  };

  const handleIntervalValueChange = (v: number) => {
    setIntervalValue(v);
    emitCron(mode, v, intervalUnit, hour, minute, days, rawCron);
  };

  const handleIntervalUnitChange = (u: 'minutes' | 'hours') => {
    setIntervalUnit(u);
    emitCron(mode, intervalValue, u, hour, minute, days, rawCron);
  };

  const handleHourChange = (h: number) => {
    setHour(h);
    emitCron(mode, intervalValue, intervalUnit, h, minute, days, rawCron);
  };

  const handleMinuteChange = (m: number) => {
    setMinute(m);
    emitCron(mode, intervalValue, intervalUnit, hour, m, days, rawCron);
  };

  const handleRawCronChange = (rc: string) => {
    setRawCron(rc);
    emitCron('cron', intervalValue, intervalUnit, hour, minute, days, rc);
  };

  const toggleDay = (day: number) => {
    setDays(prev => {
      const next = prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day];
      emitCron(mode, intervalValue, intervalUnit, hour, minute, next, rawCron);
      return next;
    });
  };

  const inputCls = 'bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary';
  const tabCls = (active: boolean) => cn(
    'px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer',
    active
      ? 'bg-primary/10 text-primary'
      : 'text-on-surface-variant hover:text-white hover:bg-[#20201f]',
  );

  const description = describeCron(value);

  return (
    <div className={cn('space-y-3', className)}>
      {/* Mode tabs */}
      <div className="flex items-center gap-1 p-1 bg-[#131313] rounded-lg">
        <button type="button" className={tabCls(mode === 'preset')} onClick={() => setMode('preset')}>
          <Clock className="w-3.5 h-3.5 inline mr-1" />Presets
        </button>
        <button type="button" className={tabCls(mode === 'interval')} onClick={() => setMode('interval')}>
          <Repeat className="w-3.5 h-3.5 inline mr-1" />Interval
        </button>
        <button type="button" className={tabCls(mode === 'daily')} onClick={() => setMode('daily')}>
          Daily
        </button>
        <button type="button" className={tabCls(mode === 'weekly')} onClick={() => setMode('weekly')}>
          <Calendar className="w-3.5 h-3.5 inline mr-1" />Weekly
        </button>
        <button type="button" className={tabCls(mode === 'cron')} onClick={() => { setMode('cron'); setRawCron(value); }}>
          Cron
        </button>
        <button type="button" className={tabCls(mode === 'datetime')} onClick={() => setMode('datetime')}>
          <Calendar className="w-3.5 h-3.5 inline mr-1" />Date & Time
        </button>
      </div>

      {/* Preset grid */}
      {mode === 'preset' && (
        <div className="grid grid-cols-2 gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.cron}
              type="button"
              onClick={() => handlePresetClick(preset)}
              className={cn(
                'text-left px-3 py-2 rounded-lg border text-sm transition-colors cursor-pointer',
                value === preset.cron
                  ? 'border-primary bg-primary/10'
                  : 'border-outline-variant/10 hover:border-on-surface-variant/20 hover:bg-[#20201f]',
              )}
            >
              <div className="font-medium text-white">{preset.label}</div>
              <div className="text-xs text-on-surface-variant mt-0.5">{preset.description}</div>
            </button>
          ))}
        </div>
      )}

      {/* Interval mode */}
      {mode === 'interval' && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-on-surface-variant">Every</span>
          <input
            type="number"
            min={1}
            max={intervalUnit === 'minutes' ? 59 : 23}
            value={intervalValue}
            onChange={e => handleIntervalValueChange(Math.max(1, parseInt(e.target.value) || 1))}
            className={cn(inputCls, 'w-20 text-center')}
          />
          <select
            value={intervalUnit}
            onChange={e => handleIntervalUnitChange(e.target.value as 'minutes' | 'hours')}
            className={cn(inputCls, 'w-28')}
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
        </div>
      )}

      {/* Daily mode */}
      {mode === 'daily' && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-on-surface-variant">Every day at</span>
          <input
            type="number"
            min={0}
            max={23}
            value={hour}
            onChange={e => handleHourChange(Math.min(23, Math.max(0, parseInt(e.target.value) || 0)))}
            className={cn(inputCls, 'w-16 text-center')}
          />
          <span className="text-on-surface-variant">:</span>
          <input
            type="number"
            min={0}
            max={59}
            value={minute}
            onChange={e => handleMinuteChange(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
            className={cn(inputCls, 'w-16 text-center')}
          />
        </div>
      )}

      {/* Weekly mode */}
      {mode === 'weekly' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-on-surface-variant">At</span>
            <input
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={e => handleHourChange(Math.min(23, Math.max(0, parseInt(e.target.value) || 0)))}
              className={cn(inputCls, 'w-16 text-center')}
            />
            <span className="text-on-surface-variant">:</span>
            <input
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={e => handleMinuteChange(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
              className={cn(inputCls, 'w-16 text-center')}
            />
            <span className="text-sm text-on-surface-variant">on</span>
          </div>
          <div className="flex gap-1.5">
            {DAYS_OF_WEEK.map((day) => (
              <button
                key={day.value}
                type="button"
                onClick={() => toggleDay(day.value)}
                className={cn(
                  'w-10 h-10 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                  days.includes(day.value)
                    ? 'bg-primary text-[#0e0e0e] shadow-sm'
                    : 'bg-[#262626] text-on-surface-variant hover:bg-[#20201f]',
                )}
                title={day.label}
              >
                {day.short}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Raw cron mode */}
      {mode === 'cron' && (
        <div>
          <input
            type="text"
            value={rawCron}
            onChange={e => handleRawCronChange(e.target.value)}
            className={cn(inputCls, 'w-full font-mono')}
            placeholder="* * * * *"
          />
          <p className="text-xs text-on-surface-variant mt-1">
            Format: minute hour day-of-month month day-of-week
          </p>
        </div>
      )}

      {/* Datetime mode */}
      {mode === 'datetime' && (() => {
        // Parse datetimeValue into separate date and time parts
        const dtDate = datetimeValue ? datetimeValue.slice(0, 10) : '';
        const dtTime = datetimeValue ? datetimeValue.slice(11, 16) : '';

        const emitDatetime = (date: string, time: string) => {
          if (date && time) {
            const combined = `${date}T${time}`;
            setDatetimeValue(combined);
            onScheduledAtChange?.(new Date(combined).toISOString());
          } else if (date && !time) {
            // Date selected but no time yet — store partial, don't emit
            setDatetimeValue(`${date}T`);
          } else {
            setDatetimeValue('');
            onScheduledAtChange?.(null);
          }
        };

        return (
          <div className="space-y-3">
            <p className="text-sm text-on-surface-variant">Run once at a specific date and time:</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-on-surface-variant mb-1">Date</label>
                <input
                  type="date"
                  value={dtDate}
                  onChange={e => emitDatetime(e.target.value, dtTime || '09:00')}
                  min={new Date().toISOString().slice(0, 10)}
                  className={cn(inputCls, 'w-full')}
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-on-surface-variant mb-1">Time</label>
                <input
                  type="time"
                  value={dtTime}
                  onChange={e => emitDatetime(dtDate, e.target.value)}
                  className={cn(inputCls, 'w-full')}
                />
              </div>
            </div>
            <p className="text-xs text-on-surface-variant">
              The task will execute exactly once at this time, then auto-disable.
            </p>
          </div>
        );
      })()}

      {/* Preview */}
      {(value || (mode === 'datetime' && datetimeValue)) && (
        <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 border border-primary/20 rounded-lg">
          <Clock className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-sm text-primary font-medium">
            {mode === 'datetime' && datetimeValue
              ? `Once at ${new Date(datetimeValue).toLocaleString()}`
              : description}
          </span>
          {mode !== 'cron' && mode !== 'datetime' && (
            <span className="text-xs text-primary/60 font-mono ml-auto">{value}</span>
          )}
        </div>
      )}
    </div>
  );
}
