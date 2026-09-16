/** Opt-in paid OpenRouter wire benchmark. Never reads application conversation data. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { OpenRouterProvider } from '../src/models/providers/openrouter-provider';
import type { AgentMessage } from '../src/core/types';
import type { CompletionResult } from '../src/models/litellm-client';

const model = process.env.OPENROUTER_BENCHMARK_MODEL;
if (!model || !process.env.OPENROUTER_API_KEY) {
  throw new Error('Set OPENROUTER_API_KEY and OPENROUTER_BENCHMARK_MODEL to run this paid synthetic benchmark.');
}
const requestedTurns = Number(process.env.SESSION_BENCHMARK_TURNS ?? 20);
if (!Number.isInteger(requestedTurns) || requestedTurns < 2 || requestedTurns > 50) throw new Error('SESSION_BENCHMARK_TURNS must be 2..50');
const provider = new OpenRouterProvider();
const sessionId = randomUUID();
const messages: AgentMessage[] = [{ role: 'system', timestamp: new Date(), content:
  'You are testing conversation continuity. Remember every supplied code. Return only the code requested. ' +
  Array.from({ length: 300 }, (_, i) => `Reference ${i}: preserve verified facts, follow the latest question, keep responses brief.`).join('\n') }];
const samples: object[] = [];
let costKnown = true; let reportedCost = 0; let inputTokens = 0; let cacheReads = 0; let cacheWrites = 0;
for (let turn = 1; turn <= requestedTurns; turn++) {
  const expected = `CODE_${turn - 1}`;
  messages.push({ role: 'user', timestamp: new Date(), content:
    `The code for turn ${turn} is CODE_${turn}. ` + (turn === 1 ? 'Reply CODE_1.' : `Reply only with the code for turn ${turn - 1}.`) });
  const started = performance.now();
  const options = { model, messages, sessionId, userId: 'synthetic-benchmark', cacheScope: 'root:benchmark', maxTokens: 256, temperature: 0 };
  let content = ''; let usage: CompletionResult['usage'] | undefined; let raw: CompletionResult['providerRaw'];
  if (turn % 2 === 0) {
    for await (const chunk of provider.stream(options)) {
      content += chunk.content ?? ''; if (chunk.usage) usage = chunk.usage; if (chunk.providerRaw) raw = chunk.providerRaw;
    }
  } else {
    const result = await provider.complete(options); content = result.content; usage = result.usage; raw = result.providerRaw;
  }
  const latencyMs = Math.round(performance.now() - started);
  messages.push({ role: 'assistant', content, providerRaw: raw, timestamp: new Date() });
  inputTokens += usage?.inputTokens ?? 0; cacheReads += usage?.cacheReadTokens ?? 0; cacheWrites += usage?.cacheCreationTokens ?? 0;
  if (usage?.reportedCost === undefined) costKnown = false; else reportedCost += usage.reportedCost;
  const recallPassed = content.trim() === (turn === 1 ? 'CODE_1' : expected);
  samples.push({ turn, stream: turn % 2 === 0, latencyMs, recallPassed, usage: usage ?? null });
  console.log(JSON.stringify({ turn, latencyMs, recallPassed, cacheReadTokens: usage?.cacheReadTokens ?? null }));
}
const report = { kind: 'live OpenRouter synthetic wire benchmark; no application data or compaction', model, turns: requestedTurns,
  inputTokens, cacheReads, cacheWrites, cacheReadRatio: inputTokens ? cacheReads / inputTokens : null,
  reportedCost: costKnown ? reportedCost : null, samples };
const output = process.env.SESSION_BENCHMARK_REPORT ?? 'openrouter-session-benchmark.json';
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Wrote ${output}`);
