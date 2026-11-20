import { writeFileSync } from 'node:fs';
import { afterAll, expect, test, vi } from 'vitest';
import type { ToolHandler } from '@/core/agent-base';
import type { AgentContext } from '@/core/types';
import { buildCodemodeHandler, CODEMODE_MAX_SOURCE_BYTES } from './codemode';

vi.mock('@/core/rag/embeddings', () => ({ getEmbeddingService: () => ({ generateEmbedding: async () => { throw new Error('probe has no embedding provider'); } }), sha256Hex: (s: string) => s }));

const rows: Array<Record<string, unknown>> = [];
const ctx = {} as AgentContext;
const definition: ToolHandler = { name: 'probe__echo', toolId: 'probe', description: 'Echo generated test data.',
  parameters: { type: 'object', properties: { value: {} }, required: ['value'] }, execute: async () => null };

const cases: Array<[string, unknown]> = [
  ['discovery-shape', 'return {first:ALL_TOOLS[0], names:ALL_TOOLS.map(t=>t.name)};'],
  ['companion-error', 'return ALL_TOOLS.filter(n=>n.startsWith("companion__")||n.includes("companion"));'],
  ['discovery-fixed', 'return ALL_TOOLS.filter(t=>t.name.startsWith("probe__")).map(t=>t.name);'],
  ['sequential', 'const a=await tools.probe__echo({value:1});return await tools.probe__echo({value:a+1});'],
  ['parallel-100', 'return (await Promise.all(Array.from({length:100},(_,value)=>tools.probe__echo({value})))).length;'],
  ['parallel-1000', 'return (await Promise.all(Array.from({length:1000},(_,value)=>tools.probe__echo({value})))).length;'],
  ['all-settled', 'return await Promise.allSettled([tools.probe__echo({value:1}),tools.probe__echo({value:"fail"})]);'],
  ['forgotten-await', 'tools.probe__echo({value:1}); return "finished";'],
  ['async-filter', 'return [1,2,3].filter(async value => (await tools.probe__echo({value}))>1);'],
  ['unknown-tool', 'await tools.not_a_tool({});'],
  ['missing-tool-args', 'return await tools.probe__echo();'],
  ['null-tool-args', 'return await tools.probe__echo(null);'],
  ['array-tool-args', 'return await tools.probe__echo([1,2]);'],
  ['string-tool-args', 'return await tools.probe__echo("wrong");'],
  ['wrong-field', 'return await tools.probe__echo({wrong:1});'],
  ['missing-code', undefined], ['number-code', 42], ['empty-code',''],
  ['markdown-fence','```js\nreturn 1;\n```'],
  ['unknown-options','// @options: {"unknown":1}\nreturn 1;'],
  ['misplaced-options','\n// @options: {"timeout_ms":10}\nreturn 1;'],
  ['wrong-directive','// @exec: {"max_output_tokens":1}\nreturn "text ".repeat(1000);'],
  ['output-default-100k','return "A normal sentence. ".repeat(6000);'],
  ['output-zero','// @options: {"max_output_tokens":0}\nreturn "A normal sentence. ".repeat(6000);'],
  ['output-one','// @options: {"max_output_tokens":1}\nreturn "A normal sentence. ".repeat(6000);'],
  ['output-2000','// @options: {"max_output_tokens":2000}\nreturn "A normal sentence. ".repeat(6000);'],
  ['many-output-items','// @options: {"timeout_ms":3000}\nfor(let i=0;i<100001;i++)text("");'],
  ['text-over-16m','// @options: {"timeout_ms":3000}\ntext("x".repeat(17*1024*1024));'],
  ['return-over-16m','// @options: {"timeout_ms":3000,"max_output_tokens":100}\nreturn "x".repeat(17*1024*1024);'],
  ['request-256k', '/*'+'x'.repeat(256*1024-32)+'*/\nreturn 1;'],
  ['request-2m', '/*'+'x'.repeat(2*1024*1024)+'*/\nreturn 1;'],
  ['tool-argument-2m', 'return (await tools.probe__echo({value:"x".repeat(2*1024*1024)})).length;'],
  ['store-one-over-limit', 'store("large","x".repeat(256*1024+1));'],
  ['store-total-over-limit', 'for(let i=0;i<10;i++)store("k"+i,"x".repeat(150000));'],
  ['store-prototype-key', 'store("__proto__", {polluted:true});return load("__proto__");'],
  ['undefined-result', 'return undefined;'], ['bigint-result','return 1n;'],
  ['cyclic-result','const a={};a.self=a;return a;'],
  ['cpu-timeout','// @options: {"timeout_ms":100}\nwhile(true){}'],
  ['unresolved-promise','// @options: {"timeout_ms":200}\nawait new Promise(()=>{});'],
  ['missing-timer','await new Promise(resolve=>setTimeout(resolve,1));'],
  ['sandbox-capabilities','return {fetch:typeof fetch,process:typeof process,require:typeof require,WebAssembly:typeof WebAssembly};'],
  ['vm-memory-limit','// @options: {"timeout_ms":2000}\nreturn "x".repeat(300*1024*1024).length;'],
];

test.each(cases)('boundary %s', async (name, code) => {
  let calls = 0;
  const argumentsSeen: string[] = [];
  const handler = buildCodemodeHandler({ tools: () => [definition], call: async call => {
    calls++;
    argumentsSeen.push(Array.isArray(call.arguments) ? 'array' : typeof call.arguments);
    await new Promise(resolve => setTimeout(resolve, 1));
    return call.arguments.value === 'fail' ? { toolCallId: call.id, result: null, error: 'expected fixture failure' }
      : { toolCallId: call.id, result: call.arguments.value ?? { received: call.arguments } };
  } });
  const started = Date.now();
  try {
    const out = await handler.execute({ code }, ctx);
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    rows.push({ name, status: 'ok', ms: Date.now()-started, calls, argumentsSeen: [...new Set(argumentsSeen)], outputChars: text.length, preview: text.slice(0,300) });
  } catch(error) {
    rows.push({ name, status: 'error', ms: Date.now()-started, calls, argumentsSeen: [...new Set(argumentsSeen)], error: String(error).slice(0,800) });
  }
  const expectedErrors = new Set(['companion-error','unknown-tool','missing-tool-args','null-tool-args','array-tool-args','string-tool-args','wrong-field','missing-code','number-code','empty-code','markdown-fence','unknown-options','misplaced-options','wrong-directive','many-output-items','text-over-16m','request-2m','store-one-over-limit','store-total-over-limit','bigint-result','cyclic-result','cpu-timeout','unresolved-promise','missing-timer','vm-memory-limit']);
  expect(rows.at(-1)?.status, JSON.stringify(rows.at(-1))).toBe(expectedErrors.has(name) ? 'error' : 'ok');
  if (['missing-tool-args','null-tool-args','array-tool-args','string-tool-args','wrong-field','request-2m'].includes(name)) expect(calls).toBe(0);
  if (name === 'output-zero') expect(rows.at(-1)?.outputChars).toBeLessThan(100);
  if (name === 'output-default-100k') expect(rows.at(-1)?.outputChars).toBeLessThan(8100);
  if (name === 'parallel-100') expect(calls).toBe(100);
  if (name === 'parallel-1000') expect(calls).toBe(1000);
}, 10000);

afterAll(() => { if (process.env.CODEMODE_PROBE_REPORT) writeFileSync(process.env.CODEMODE_PROBE_REPORT,JSON.stringify(rows,null,2)); });

test('rejects misplaced top-level options instead of ignoring them', async () => {
  const h = buildCodemodeHandler({ tools: () => [], call: async c => ({ toolCallId: c.id, result: null }) });
  await expect(h.execute({ code: 'return 1;', timeout_ms: 1 }, ctx)).rejects.toThrow('put timeout_ms and max_output_tokens in the first');
});

test('source cap measures UTF-8 bytes and accepts the exact boundary', async () => {
  const h = buildCodemodeHandler({ tools: () => [], call: async c => ({ toolCallId: c.id, result: null }) });
  const prefix = '/*', suffix = '*/return 1;';
  const room = CODEMODE_MAX_SOURCE_BYTES - Buffer.byteLength(prefix + suffix);
  const source = prefix + 'é'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2) + suffix;
  expect(Buffer.byteLength(source)).toBe(CODEMODE_MAX_SOURCE_BYTES);
  await expect(h.execute({ code: source }, ctx)).resolves.toContain('Script completed');
  await expect(h.execute({ code: source + ' ' }, ctx)).rejects.toThrow('source exceeds');
});

test('large explicit output budgets and thrown errors remain bounded', async () => {
  const h = buildCodemodeHandler({ tools: () => [], call: async c => ({ toolCallId: c.id, result: null }) });
  const out = await h.execute({ code: '// @options: {"max_output_tokens":999999999}\nreturn "some text. ".repeat(40000);' }, ctx) as string;
  expect(out.length).toBeLessThan(128100);
  expect(out).toContain('chars truncated');
  const error = await h.execute({ code: '// @options: {"max_output_tokens":0}\nthrow new Error("failure. ".repeat(20000));' }, ctx).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message.length).toBeLessThan(1200);
  expect((error as Error).message).toContain('chars truncated');
});

test('prototype-like storage keys survive the next call without leaking to another worker', async () => {
  const host = { tools: () => [], call: async (c: import('@/core/types').ToolCall) => ({ toolCallId: c.id, result: null }) };
  const h = buildCodemodeHandler(host);
  await h.execute({ code: 'store("__proto__",{remembered:true});' }, ctx);
  const restored = await h.execute({ code: 'return load("__proto__");' }, ctx);
  expect(restored).toContain('"remembered":true');
  const other = await buildCodemodeHandler(host).execute({ code: 'return load("__proto__") ?? "absent";' }, ctx);
  expect(other).toContain('absent');
  expect(Object.hasOwn({}, 'remembered')).toBe(false);
});

test('a JavaScript alias from ALL_TOOLS can be described and invoked', async () => {
  const calls: string[] = [];
  const h = buildCodemodeHandler({ tools: () => [{ ...definition, name: 'probe-tool__echo-value' }], call: async c => { calls.push(c.name); return { toolCallId: c.id, result: 'ok' }; } });
  const out = await h.execute({ code: 'const name=ALL_TOOLS[0].name; const declaration=await describeTool(name); if(typeof declaration!=="string") throw Error("missing signature"); return await tools[name]({value:1});' }, ctx);
  expect(out).toContain('ok');
  expect(calls).toEqual(['probe-tool__echo-value']);
});

test('colliding sanitized names stay individually discoverable and dispatch to the right tool', async () => {
  const calls: string[] = [];
  const h = buildCodemodeHandler({ tools: () => ['probe-tool', 'probe_tool'].map(name => ({ ...definition, name })), call: async c => { calls.push(c.name); return { toolCallId: c.id, result: c.name }; } });
  const out = await h.execute({ code: 'const names=ALL_TOOLS.map(t=>t.name); if(new Set(names).size!==2)throw Error("collision"); for(const name of names){ if(!(await describeTool(name)))throw Error("missing"); text(await tools[name]({value:1})); }' }, ctx);
  expect(calls).toEqual(['probe-tool', 'probe_tool']);
  expect(out).toContain('probe-tool');
  expect(out).toContain('probe_tool');
});

test('timeouts do not poison the next invocation', async () => {
  const h = buildCodemodeHandler({ tools: () => [], call: async c => ({ toolCallId: c.id, result: null }) });
  await expect(h.execute({ code: '// @options: {"timeout_ms":100}\nwhile(true){}' }, ctx)).rejects.toThrow('timeout');
  await expect(h.execute({ code: 'return "still usable";' }, ctx)).resolves.toContain('still usable');
});

test('global and lexical storage access share one namespace, including deletion and state: keys', async () => {
  const h = buildCodemodeHandler({ tools: () => [], call: async c => ({ toolCallId: c.id, result: null }) });
  const first = await h.execute({ code: 'globalThis.store("cursor",7); const {store:s,load:l}=globalThis; s("state:cursor",8); return [load("cursor"),l("state:cursor")];' }, ctx);
  expect(first).toContain('[7,8]');
  const next = await h.execute({ code: 'store("cursor",undefined); return [globalThis.load("cursor")??null,load("state:cursor")];' }, ctx);
  expect(next).toContain('[null,8]');
});

test.each([null, 42, 'some state', { saved: true }])('prototype-like key preserves JSON value %j', async value => {
  const h = buildCodemodeHandler({ tools: () => [], call: async c => ({ toolCallId: c.id, result: null }) });
  await h.execute({code: `globalThis.store("__proto__",${JSON.stringify(value)});`}, ctx);
  const out = await h.execute({code: 'return JSON.stringify(load("__proto__"));'}, ctx);
  expect(out).toContain(JSON.stringify(value));
});

test('validation diagnostics cannot echo huge unknown keys into context', async () => {
  const h = buildCodemodeHandler({ tools: () => [], call: async c => ({ toolCallId: c.id, result: null }) });
  for (const args of [{code:'return 1;', ['x'.repeat(100000)]:1}, {code:`// @options: {"${'x'.repeat(100000)}":1}\nreturn 1;`}]) {
    const error = await h.execute(args,ctx).catch((e:Error)=>e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeLessThan(1100);
  }
});
