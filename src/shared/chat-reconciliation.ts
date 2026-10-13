type Message = { id: string; role: string; content: string; timestamp: Date | string };

/**
 * Rows shown before REST had them: this tab's optimistic sends (numeric ids)
 * and rows that arrived as gateway events (`gw-<eventId>`, e.g. another tab's
 * steered message or a turn's reply). Each is replaced by its persisted copy.
 */
const PROVISIONAL_ID = /^(\d+|gw-.+)$/;

/** REST can lag live delivery. Consume matching provisional rows one-for-one. */
export function reconcileChatMessages<T extends Message>(persisted: T[], visible: T[]): T[] {
  const ids = new Set(persisted.map(message => message.id));
  const visibleIds = new Set(visible.map(message => message.id));
  const unmatched = persisted.filter(message => !visibleIds.has(message.id));
  const anchors = new Map(visible.map(message => [message.id, message.timestamp]));
  const retained = visible.filter(message => {
    if (message.id === '0' || ids.has(message.id)) return false;
    if (PROVISIONAL_ID.test(message.id)) {
      const index = unmatched.findIndex(row => row.role === message.role && row.content === message.content
        && Math.abs(new Date(row.timestamp).getTime() - new Date(message.timestamp).getTime()) < 60_000);
      if (index >= 0) {
        anchors.set(unmatched[index].id, message.timestamp);
        unmatched.splice(index, 1); return false;
      }
    }
    return true;
  });
  // Keep the position already displayed; server/client clocks may differ.
  const shown = new Map(visible.map(message => [message.id, message]));
  const result = [...persisted.filter(message => message.id !== '0').map(message => sameAsShown({
    ...message, timestamp: anchors.get(message.id) ?? message.timestamp,
  }, shown)), ...retained];
  if (!result.length) return persisted;
  result.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp));
  return result.length === visible.length && result.every((message, i) => message === visible[i]) ? visible : result;
}

/**
 * The row already on screen when the refetched copy is identical. The chat
 * re-fetches a session's history on a timer; handing back the same objects
 * (and the same array when nothing changed) lets memoized rows skip a
 * re-render and a markdown re-parse of the whole conversation.
 */
function sameAsShown<T extends Message>(message: T, shown: Map<string, T>): T {
  const row = shown.get(message.id);
  return row && JSON.stringify(row) === JSON.stringify(message) ? row : message;
}
