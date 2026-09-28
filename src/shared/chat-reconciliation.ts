type Message = { id: string; role: string; content: string; timestamp: Date | string };

/** REST can lag live delivery. Consume matching optimistic rows one-for-one. */
export function reconcileChatMessages<T extends Message>(persisted: T[], visible: T[]): T[] {
  const ids = new Set(persisted.map(message => message.id));
  const visibleIds = new Set(visible.map(message => message.id));
  const unmatched = persisted.filter(message => !visibleIds.has(message.id));
  const retained = visible.filter(message => {
    if (message.id === '0' || ids.has(message.id)) return false;
    if (/^\d+$/.test(message.id)) {
      const index = unmatched.findIndex(row => row.role === message.role && row.content === message.content
        && Math.abs(new Date(row.timestamp).getTime() - new Date(message.timestamp).getTime()) < 60_000);
      if (index >= 0) { unmatched.splice(index, 1); return false; }
    }
    return true;
  });
  const result = [...persisted.filter(message => message.id !== '0'), ...retained];
  return result.length ? result.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp)) : persisted;
}
