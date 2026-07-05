/**
 * Classifier — chat/work split (Thread 3) output-mode heuristic, plus a couple
 * of sanity checks that adding `outputMode` didn't disturb existing routing.
 */
import { describe, expect, test } from 'bun:test';
import { classifyMessage } from './classifier';

describe('classifyMessage — outputMode (chat/work split)', () => {
  test.each([
    'Write me a poem about the ocean at night',
    'Draft a cover letter for a senior backend engineer role',
    'Create a project proposal for the migration',
    'Generate a README for this library',
    'Write a report summarizing the quarter',
    'compose an essay on urban design',
  ])('document-authoring → file: %s', (input) => {
    expect(classifyMessage(input)).toMatchObject({ outputMode: 'file' });
  });

  test.each([
    "What's the capital of France?",
    'Explain how OAuth2 PKCE works',
    'Thanks, that was helpful!',
    'What is 2+2?',
    'Implement a REST API endpoint for user registration',
    'Set up a Docker Compose configuration for our services',
    'create a function that reverses a string',
    'make sure the tests pass',
  ])('non-authoring → inline: %s', (input) => {
    expect(classifyMessage(input)).toMatchObject({ outputMode: 'inline' });
  });

  test('every classification carries an outputMode', () => {
    for (const input of ['hi', 'yes', 'implement a parser', 'write me a story']) {
      expect(classifyMessage(input).outputMode).toBeDefined();
    }
  });
});

describe('classifyMessage — existing behavior unchanged', () => {
  test('greeting is still casual', () => {
    expect(classifyMessage('Hey, how are you?').type).toBe('casual');
  });

  test('coding request is still a task routed to coding', () => {
    expect(classifyMessage('Implement a REST API endpoint for user registration')).toMatchObject({
      type: 'task',
      topic: 'coding',
    });
  });

  test('approval is still approval', () => {
    expect(classifyMessage('approve').type).toBe('approval');
  });
});

describe('classifyMessage — review routing (push-review hooks)', () => {
  test('a guideline-review prompt routes to review, not research', () => {
    const input =
      'Review the changes against our repo guidelines (Design.md, Contribution.md, Security.md) and give a summary.';
    expect(classifyMessage(input)).toMatchObject({ type: 'task', topic: 'review' });
  });

  test('"code review this PR" routes to review', () => {
    expect(classifyMessage('Please do a code review of this pull request').topic).toBe('review');
  });

  test('a plain research request still routes to research', () => {
    expect(classifyMessage('Research the best caching strategies and summarize the tradeoffs').topic).toBe('research');
  });
});

describe('classifyMessage — call/delivery intent beats topical tie', () => {
  // "call me" (communication) and "tell me about" (research) both score 1.5;
  // the leading phone-call command must win so the agent gets the voice tool.
  test('"call me and tell me about X" routes to communication, not research', () => {
    expect(classifyMessage('call me and tell me about octipus').topic).toBe('communication');
    expect(classifyMessage('ring me and tell me about the weather').topic).toBe('communication');
  });

  test('a plain "tell me about X" (no call) still routes to research', () => {
    expect(classifyMessage('tell me about octipus').topic).toBe('research');
  });
});
