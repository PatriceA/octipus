/** Commands that must reach an active session without waiting for its running turn. */
export function isSessionControlMessage(message: string): boolean {
  return /^\/(?:stop|clear|status|cancel|help)(?:\s|$)/i.test(message.trim());
}
