/** Bounds the whole MCP handler, including auth and local work before its HTTP request. */
export async function withToolDeadline(run: () => unknown, timeoutMs = 30_000): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(run), new Promise(resolve => {
      timer = setTimeout(() => resolve({ isError: true, content: [{ type: 'text',
        text: `Octipus tool timed out after ${timeoutMs}ms. Its outcome may be unknown; inspect status before repeating a mutation.` }] }), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
