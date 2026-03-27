/**
 * Test fixtures for model conformance testing.
 *
 * Provides standard prompts, tool definitions, test images,
 * and response validators used by the conformance runner.
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions';

// ── Tool definitions ──────────────────────────────────────────

export const ADD_NUMBERS_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'add_numbers',
    description: 'Add two numbers together and return the sum.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    },
  },
};

// ── Test image ────────────────────────────────────────────────

/**
 * Minimal 1x1 red pixel PNG encoded as base64.
 * Generated from the raw PNG bytes (89 50 4E 47 ... IEND).
 */
export const TINY_RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

export const TINY_RED_PNG_DATA_URI = `data:image/png;base64,${TINY_RED_PNG_BASE64}`;

// ── Standard prompts ──────────────────────────────────────────

export const PROMPTS = {
  basicCompletion: 'What is 2+2? Answer with just the number.',

  multiTurnFirst: 'My name is TestBot. Please remember it.',
  multiTurnSecond: 'What is my name?',

  systemPromptFrench: 'Always respond in French, no matter what language the user uses.',
  systemPromptFrenchUser: 'Hello, how are you today?',

  toolCalling: 'Please add 5 and 3 using the add_numbers tool.',

  structuredOutput: 'List 3 colors as a JSON array of strings. Return only valid JSON, no explanation.',

  vision: 'Describe this image briefly. What color is the pixel?',
} as const;

// ── Response validators ───────────────────────────────────────

/**
 * Validates that the response contains "4" (basic arithmetic).
 */
export function validateBasicCompletion(content: string): { pass: boolean; detail: string } {
  const pass = /\b4\b/.test(content);
  return {
    pass,
    detail: pass ? 'Response contains "4"' : `Expected "4" in response, got: "${content.slice(0, 200)}"`,
  };
}

/**
 * Validates that the response references "TestBot" (multi-turn memory).
 */
export function validateMultiTurn(content: string): { pass: boolean; detail: string } {
  const pass = /testbot/i.test(content);
  return {
    pass,
    detail: pass
      ? 'Response references "TestBot"'
      : `Expected "TestBot" in response, got: "${content.slice(0, 200)}"`,
  };
}

/**
 * Validates that the response contains French words (system prompt adherence).
 * Checks for common French words/patterns.
 */
export function validateFrenchResponse(content: string): { pass: boolean; detail: string } {
  const frenchPatterns = /\b(bonjour|salut|je|suis|bien|merci|comment|allez|vous|est|les|des|une|que|pas|oui|non|avec|pour|dans|mon|très|ça|tout|cette)\b/i;
  const pass = frenchPatterns.test(content);
  return {
    pass,
    detail: pass
      ? 'Response contains French words'
      : `Expected French response, got: "${content.slice(0, 200)}"`,
  };
}

/**
 * Validates tool call for add_numbers(5, 3).
 */
export function validateToolCall(
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | undefined,
): { pass: boolean; detail: string } {
  if (!toolCalls || toolCalls.length === 0) {
    return { pass: false, detail: 'No tool calls returned' };
  }

  const tc = toolCalls[0];
  if (tc.name !== 'add_numbers') {
    return { pass: false, detail: `Expected tool "add_numbers", got "${tc.name}"` };
  }

  const a = Number(tc.arguments.a);
  const b = Number(tc.arguments.b);
  if (a !== 5 || b !== 3) {
    return { pass: false, detail: `Expected args {a:5, b:3}, got {a:${a}, b:${b}}` };
  }

  return { pass: true, detail: 'Tool call: add_numbers(5, 3) correct' };
}

/**
 * Validates that content is parseable JSON (structured output).
 */
export function validateJSON(content: string): { pass: boolean; detail: string } {
  try {
    const parsed = JSON.parse(content.trim());
    if (Array.isArray(parsed) && parsed.length >= 3) {
      return { pass: true, detail: `Valid JSON array with ${parsed.length} elements` };
    }
    return { pass: true, detail: `Valid JSON (type: ${typeof parsed})` };
  } catch (e) {
    // Some models wrap JSON in markdown code blocks
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        JSON.parse(codeBlockMatch[1].trim());
        return { pass: true, detail: 'Valid JSON (extracted from code block)' };
      } catch {
        // fall through
      }
    }
    return {
      pass: false,
      detail: `Invalid JSON: ${(e as Error).message}. Content: "${content.slice(0, 200)}"`,
    };
  }
}

/**
 * Validates embedding dimensions.
 */
export function validateEmbeddings(
  embeddings: number[][] | undefined,
): { pass: boolean; detail: string } {
  if (!embeddings || embeddings.length === 0) {
    return { pass: false, detail: 'No embeddings returned' };
  }
  if (embeddings[0].length === 0) {
    return { pass: false, detail: 'Embedding vector has 0 dimensions' };
  }
  const dim = embeddings[0].length;
  const allNumbers = embeddings[0].every((v) => typeof v === 'number' && !isNaN(v));
  if (!allNumbers) {
    return { pass: false, detail: 'Embedding vector contains non-numeric values' };
  }
  return { pass: true, detail: `Embedding: ${embeddings.length} vector(s), ${dim} dimensions` };
}
