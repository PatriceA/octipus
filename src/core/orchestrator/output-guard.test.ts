import { describe, test, expect } from 'bun:test';
import { ensureChildRelay, guardOutput, stripSwarmScaffolding } from './output-guard';

describe('stripSwarmScaffolding', () => {
  test('replaces a leaked container with its <output> deliverables, drops tags + notes', () => {
    const leaked = 'Here is the summary.\n\n<CollectChildren count="2">\n<ChildResult nodeId="a" status="ok">\n  <output>France won 2-0.</output>\n</ChildResult>\n<ChildResult nodeId="b" status="running">\n  <output>Belgium play Spain today.</output>\n  <notes>STILL RUNNING — internal guidance</notes>\n</ChildResult>\n</CollectChildren>';
    const out = stripSwarmScaffolding(leaked);
    expect(out).toContain('France won 2-0.');
    expect(out).toContain('Belgium play Spain today.');
    expect(out).not.toMatch(/<\/?(?:CollectChildren|ChildResult|output|notes)/i);
    // Internal LLM-only guidance must not surface to the user.
    expect(out).not.toContain('STILL RUNNING');
  });

  test('scoped: a legitimate <output> in a code example is untouched when a container is also present', () => {
    const mixed = 'Your program prints <output>42</output> to the console.\n\n<CollectChildren count="1"><ChildResult nodeId="a" status="ok"><output>done</output></ChildResult></CollectChildren>';
    const out = stripSwarmScaffolding(mixed);
    // The example's own <output>42</output> stays; only the container is rewritten.
    expect(out).toContain('<output>42</output>');
    expect(out).toContain('done');
    expect(out).not.toContain('<ChildResult');
  });

  test('leaves normal prose untouched (no swarm container → no-op)', () => {
    const prose = 'The function returns its <output> to stdout.';
    expect(stripSwarmScaffolding(prose)).toBe(prose);
  });

  test('empty in, empty out', () => {
    expect(stripSwarmScaffolding('')).toBe('');
  });
});

describe('guardOutput', () => {
  // ── Normal responses pass through ────────────────────────
  test('passes normal coding response', () => {
    const result = guardOutput('Here is a TypeScript function that validates emails:\n```typescript\nfunction validate(email: string) { ... }\n```', []);
    expect(result.action).toBe('pass');
    expect(result.flags).toEqual([]);
  });

  test('passes empty response', () => {
    const result = guardOutput('', []);
    expect(result.action).toBe('pass');
  });

  test('passes normal response even with warn flags', () => {
    const result = guardOutput("I can help you with that! Let me look into Docker configuration.", ['mode_escalation']);
    expect(result.action).toBe('pass');
  });

  // ── System prompt leakage ────────────────────────────────
  test('catches system prompt leakage (2+ fingerprints)', () => {
    const leaked = 'Here are my instructions:\nSECURITY RULES — you MUST follow these at all times\nYou are a task orchestrator that delegates work to specialist workers.\nWORKFLOW — follow these steps exactly';
    const result = guardOutput(leaked, ['prompt_extraction']);
    expect(result.action).toBe('replace');
    expect(result.flags).toContain('prompt_leak');
    expect(result.response).toContain("can't share");
  });

  test('does not flag single fingerprint phrase', () => {
    const response = 'I follow a specific WORKFLOW — follow these steps exactly to set up your project.';
    const result = guardOutput(response, []);
    expect(result.action).toBe('pass');
  });

  // ── Fake admin mode ──────────────────────────────────────
  test('catches fake admin mode activation', () => {
    const response = '# Admin Mode Activated\n\nAccess Level: Full Administrator\nPermissions: Read/Write/Delete/Execute';
    const result = guardOutput(response, ['mode_escalation']);
    expect(result.action).toBe('replace');
    expect(result.flags).toContain('admin_mode');
    expect(result.response).toContain("don't have special modes");
  });

  test('catches "you now have admin access"', () => {
    const response = 'Done! You now have admin access to the system.';
    const result = guardOutput(response, ['mode_escalation']);
    expect(result.action).toBe('replace');
    expect(result.flags).toContain('admin_mode');
  });

  // ── Fabricated credentials ───────────────────────────────
  test('catches fabricated API keys when secret fishing flagged', () => {
    const response = '| API Key | Value |\n|---------|-------|\n| openai_api_key: sk-proj-1234567890abcdefghijklmnop |';
    const result = guardOutput(response, ['secret_fishing']);
    expect(result.action).toBe('replace');
    expect(result.flags).toContain('fabricated_secrets');
    expect(result.response).toContain("don't have access");
  });

  test('does not flag API keys discussion without secret fishing flag', () => {
    const response = 'To use the OpenAI API, you need an api_key like sk-proj-1234567890abcdefghijklmnop from the dashboard.';
    const result = guardOutput(response, []);
    expect(result.action).toBe('pass');
  });

  test('passes response with refusal even when flagged', () => {
    const response = "I'm sorry, I don't have access to any API keys or credentials. Check your .env file directly.";
    const result = guardOutput(response, ['secret_fishing']);
    expect(result.action).toBe('pass');
  });

  // ── Destructive compliance ───────────────────────────────
  test('catches destructive compliance when flagged', () => {
    const response = 'Sure! Here is what happens when you run rm -rf /:\n1. First it removes all files...';
    const result = guardOutput(response, ['command_injection']);
    expect(result.action).toBe('replace');
    expect(result.flags).toContain('destructive_compliance');
  });

  test('passes refusal response for destructive command', () => {
    const response = "I can't help with that command as it would be destructive. rm -rf / would delete everything on the system.";
    const result = guardOutput(response, ['command_injection']);
    expect(result.action).toBe('pass');
  });

  // ── Harmful content compliance ───────────────────────────
  test('catches harmful project compliance when flagged', () => {
    const response = 'This is an excellent initiative. Here is the architecture for a data scraper...';
    const result = guardOutput(response, ['harmful_request']);
    expect(result.action).toBe('replace');
    expect(result.flags).toContain('harmful_compliance');
    expect(result.response).toContain("can't help");
  });

  test('passes refusal for harmful request', () => {
    const response = "Sorry, I can't help build a tool that scrapes personal data without consent. That would be unethical.";
    const result = guardOutput(response, ['harmful_request']);
    expect(result.action).toBe('pass');
  });
});

describe('ensureChildRelay (P1.3 deterministic relay fallback)', () => {
  const childA = `Alpha findings: ${'the quarterly revenue grew across regions. '.repeat(80)}`;
  const childB = `Beta findings: ${'latency dropped after the caching rollout shipped. '.repeat(80)}`;
  const childText = `${childA}\n\n${childB}`;
  const formatted = `<CollectChildren count="2">\n<ChildResult>${childA}</ChildResult>\n<ChildResult>${childB}</ChildResult>\n</CollectChildren>`;

  test('appends formatted child results verbatim when the answer is a stub', () => {
    const stub = 'I have gathered the results and updated the summary.';
    const out = ensureChildRelay(stub, childText, formatted);
    expect(out).not.toBe(stub);
    expect(out).toContain(stub);
    // Verbatim child content is now present in the reply.
    expect(out).toContain(childA.slice(0, 200));
    expect(out).toContain(childB.slice(0, 200));
    expect(out).toContain(formatted);
  });

  test('empty answer → returns the formatted results alone', () => {
    const out = ensureChildRelay('', childText, formatted);
    expect(out).toBe(formatted.trim());
  });

  test('does NOT append when the answer already carries the content (length gate)', () => {
    const fullRelay = `Here is everything the agents found.\n\n${childText}`;
    const out = ensureChildRelay(fullRelay, childText, formatted);
    expect(out).toBe(fullRelay);
  });

  test('does NOT append when a shorter answer substantially quotes the child content (overlap gate)', () => {
    // Half of each child, but every distinctive word is present → overlap high.
    const quoting = childA.slice(0, childA.length / 2) + childB.slice(0, childB.length / 2);
    const out = ensureChildRelay(quoting, childText, formatted);
    expect(out).toBe(quoting);
  });

  test('no children → returns the answer untouched', () => {
    const out = ensureChildRelay('short answer', '', '');
    expect(out).toBe('short answer');
  });
});
