/** All entry points into AgentService share this queue, including monitor wake-ups. */
const turns = new Map<string, Promise<void>>();
export async function withSessionTurn<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const previous = turns.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => held);
  turns.set(sessionId, tail);
  await previous;
  try { return await run(); }
  finally { release(); if (turns.get(sessionId) === tail) turns.delete(sessionId); }
}
