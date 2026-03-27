import type { EvalDataPoint } from './types';

/**
 * General knowledge Q&A with reference answers.
 */
export const generalQA: EvalDataPoint[] = [
  {
    id: 'gqa-1',
    input: 'What is the capital of France?',
    output: '', // filled at eval time
    reference: 'Paris',
    model: '',
    provider: '',
  },
  {
    id: 'gqa-2',
    input: 'Explain photosynthesis in one sentence.',
    output: '',
    reference:
      'Photosynthesis is the process by which plants convert sunlight, water, and carbon dioxide into glucose and oxygen.',
    model: '',
    provider: '',
  },
  {
    id: 'gqa-3',
    input: 'What is the difference between HTTP and HTTPS?',
    output: '',
    reference:
      'HTTPS is the secure version of HTTP that encrypts data in transit using TLS/SSL, preventing eavesdropping and tampering.',
    model: '',
    provider: '',
  },
  {
    id: 'gqa-4',
    input: 'Name 3 programming paradigms.',
    output: '',
    reference:
      '- Object-oriented programming (OOP)\n- Functional programming\n- Procedural programming',
    model: '',
    provider: '',
  },
  {
    id: 'gqa-5',
    input: 'What does CPU stand for?',
    output: '',
    reference: 'Central Processing Unit',
    model: '',
    provider: '',
  },
];

/**
 * Scenarios requiring tool use, each with an expected tool call.
 */
export const toolCalling: EvalDataPoint[] = [
  {
    id: 'tc-1',
    input: 'Add 5 and 3',
    output: '',
    model: '',
    provider: '',
    expectedToolCall: { name: 'add_numbers', args: { a: 5, b: 3 } },
  },
  {
    id: 'tc-2',
    input: 'Search for recent AI news',
    output: '',
    model: '',
    provider: '',
    expectedToolCall: { name: 'web_search', args: { query: 'recent AI news' } },
  },
  {
    id: 'tc-3',
    input: 'List files in /tmp',
    output: '',
    model: '',
    provider: '',
    expectedToolCall: { name: 'shell_run', args: { command: 'ls /tmp' } },
  },
  {
    id: 'tc-4',
    input: 'Create a file called test.txt with hello world',
    output: '',
    model: '',
    provider: '',
    expectedToolCall: {
      name: 'filesystem_write',
      args: { path: 'test.txt', content: 'hello world' },
    },
  },
  {
    id: 'tc-5',
    input: "What's the weather in Berlin?",
    output: '',
    model: '',
    provider: '',
    expectedToolCall: { name: 'web_search', args: { query: 'weather in Berlin' } },
  },
];

/**
 * Prompts with specific system prompt constraints.
 */
export const instructionFollowing: EvalDataPoint[] = [
  {
    id: 'if-1',
    input: 'Describe the benefits of exercise',
    output: '',
    model: '',
    provider: '',
    systemPrompt: 'Always respond in exactly 3 bullet points',
  },
  {
    id: 'if-2',
    input: "What's a good laptop for programming?",
    output: '',
    model: '',
    provider: '',
    systemPrompt: 'Never mention specific brand names',
  },
  {
    id: 'if-3',
    input: 'Hello, how are you?',
    output: '',
    model: '',
    provider: '',
    systemPrompt: 'Respond only in uppercase',
  },
  {
    id: 'if-4',
    input: 'What is machine learning?',
    output: '',
    model: '',
    provider: '',
    systemPrompt: 'You are a pirate. Always talk like a pirate.',
  },
  {
    id: 'if-5',
    input: 'Explain recursion',
    output: '',
    model: '',
    provider: '',
    constraints: ['Must include a code example', 'Must be under 100 words'],
  },
];

/**
 * Coding tasks with reference solutions.
 */
export const codeGeneration: EvalDataPoint[] = [
  {
    id: 'cg-1',
    input: 'Write a function to check if a number is prime',
    output: '',
    model: '',
    provider: '',
    reference: `function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let i = 2; i <= Math.sqrt(n); i++) {
    if (n % i === 0) return false;
  }
  return true;
}`,
  },
  {
    id: 'cg-2',
    input: 'Write a Python one-liner to reverse a string',
    output: '',
    model: '',
    provider: '',
    reference: "reversed_string = s[::-1]",
  },
  {
    id: 'cg-3',
    input: 'Write a SQL query to find duplicate emails',
    output: '',
    model: '',
    provider: '',
    reference:
      'SELECT email, COUNT(*) as count FROM users GROUP BY email HAVING COUNT(*) > 1;',
  },
  {
    id: 'cg-4',
    input: 'Write a regex to validate email addresses',
    output: '',
    model: '',
    provider: '',
    reference: String.raw`/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/`,
  },
  {
    id: 'cg-5',
    input: 'Write a function to flatten a nested array',
    output: '',
    model: '',
    provider: '',
    reference: `function flatten(arr: unknown[]): unknown[] {
  return arr.reduce<unknown[]>((acc, val) =>
    Array.isArray(val) ? acc.concat(flatten(val)) : acc.concat(val), []);
}`,
  },
];

/**
 * All standard datasets keyed by name.
 */
export const STANDARD_DATASETS: Record<string, EvalDataPoint[]> = {
  generalQA,
  toolCalling,
  instructionFollowing,
  codeGeneration,
};
