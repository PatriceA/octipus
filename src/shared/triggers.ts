/**
 * The Triggers page (docs/MISSION-CONTROL.md, "Triggers"): everything that
 * starts an agent without the user typing, what each one decided today, and
 * why a heartbeat did or did not run. Shared by the API and the web client.
 */

export const HEARTBEAT_SKIP_REASONS = [
  'disabled', 'quiet_hours', 'daily_cap', 'quota', 'spend_budget', 'nothing_pending', 'in_flight', 'tasks_permission_required',
] as const;
export type HeartbeatSkipReasonName = (typeof HEARTBEAT_SKIP_REASONS)[number];

/** One line per skip reason, in the order the gate checks them. */
export const HEARTBEAT_SKIP_LABEL: Record<HeartbeatSkipReasonName, string> = {
  disabled: 'Heartbeat switched off',
  quiet_hours: 'Quiet hours',
  daily_cap: 'Daily run cap reached',
  quota: 'Out of daily token quota',
  spend_budget: 'Spend budget paused',
  in_flight: 'Already running',
  nothing_pending: 'Nothing ready',
  tasks_permission_required: 'Needs permission to update to-dos',
};

export interface TriggerEvent {
  at: string;
  /** `ran` handled findings or dispatched work; `skipped` a heartbeat check that did not; `failed` an execution that errored. */
  kind: 'ran' | 'skipped' | 'failed';
  /** Heartbeat skip reason, or the execution's error. */
  reason: string | null;
  readyTasks: number | null;
}

export interface TriggerSummary {
  /** The hook's, monitor's or Companion goal's id. */
  id: string;
  name: string;
  /** A hook's trigger (heartbeat, schedule, webhook, message_received…), or `monitor`, or `companion`. */
  kind: string;
  /** What it starts: a hook's action, a monitor's role, Companion's dispatch. */
  action: string;
  /** Where it is managed: a monitor's session, the Companion page, Hooks & schedules. */
  href: string;
  /** A monitor's or goal's own state (armed, paused, active, waiting…), when it has one. */
  state: string | null;
  enabled: boolean;
  /** The role a role heartbeat wakes. */
  role: string | null;
  nextRunAt: string | null;
  intervalMinutes: number | null;
  lastExecutedAt: string | null;
  lastError: string | null;
  /** Today's heartbeat checks and executions, oldest first. */
  events: TriggerEvent[];
}

/** `GET /api/agents/triggers` */
export interface TriggersResponse {
  /** Start of the day `events` and `funnel` cover. */
  since: string;
  now: string;
  triggers: TriggerSummary[];
  /** Today's heartbeat checks across every heartbeat hook. */
  funnel: {
    checks: number;
    ran: number;
    skipped: Partial<Record<HeartbeatSkipReasonName, number>>;
  };
}
