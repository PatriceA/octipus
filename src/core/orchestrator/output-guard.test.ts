import { describe, test, expect } from 'bun:test';
import { guardOutput } from './output-guard';

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
