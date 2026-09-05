/**
 * Translate raw provider/agent error messages into user-readable text.
 *
 * The root agent's user-facing failure path used to render the raw
 * `(error as Error).message` directly into chat. That works for clear
 * messages but leaks ugly internals when a provider returns a JSON blob —
 * notably Ollama's `{"error":"Value looks like object, but can't find
 * closing '}' symbol"}` for malformed tool-call output. Centralize the
 * mapping so every error surface (chat, swarm node notes, logs) gets the
 * same treatment.
 *
 * Pattern matching is intentionally narrow: only known signatures get
 * rewritten. Anything else falls through unchanged so we don't hide
 * unexpected failures.
 */
export function humanizeProviderError(raw: string): string {
  const msg = raw.trim();
  if (!msg) return 'unknown error';

  if (/Value looks like object|find closing '\}' symbol/.test(msg)) {
    return 'The model produced malformed tool-call output (Ollama could not parse the response). This usually means the active model is too small for the requested task — try a larger model or simplify the prompt.';
  }

  const ollamaMissing = msg.match(/404 model ["']([^"']+)["'] not found/);
  if (ollamaMissing) {
    return `Model "${ollamaMissing[1]}" is not available on the configured provider. Pull or assign it before retrying.`;
  }

  if (/ECONNREFUSED|Cannot connect to host|ENOTFOUND|getaddrinfo/.test(msg)) {
    return 'The model provider is unreachable. Check that the upstream service (Ollama, LiteLLM, API endpoint) is running and the URL is correct.';
  }

  if (/rate.?limit|429/i.test(msg)) {
    return 'The model provider is rate-limiting requests. Wait a moment and try again, or switch to a different provider.';
  }

  if (/context.?length|context window|maximum context/i.test(msg)) {
    return 'The conversation has grown larger than the model can handle. Compaction will run on the next turn — please retry.';
  }

  return msg;
}
