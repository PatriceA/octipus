/** An explicit zero means unlimited; malformed context must not disable the installation cap. */
export function sessionTokenBudget(context: unknown, defaultBudget: number): { cap: number; explicit: boolean } {
  const value = context && typeof context === 'object' ? (context as Record<string, unknown>).tokenBudget : undefined;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? { cap: value, explicit: true } : { cap: defaultBudget, explicit: false };
}

export function sessionBudgetMessage(used: number, cap: number, explicit: boolean): string {
  return `Session token budget exhausted (${used.toLocaleString()} / ${cap.toLocaleString()} tokens). This is the conversation's cumulative limit, separate from the daily cap. `
    + (explicit ? 'This session has an explicit tokenBudget override; raise it to continue here. '
      : 'An admin can raise agent.maxTokenBudget in Settings → System → Advanced configuration → Agent (0 = unlimited). ')
    + 'You can also start a new session; that does not reset daily usage.';
}
