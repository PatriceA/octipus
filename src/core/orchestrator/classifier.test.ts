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

describe('classifyMessage — pasted code is payload, not intent', () => {
  const PAGE = `<!DOCTYPE html><html lang="en"><head><style>.card{background:white}</style></head>
<body><div class="card"><button onclick="newPrompt()">New</button></div>
<script>function newPrompt(){ const words=[["Love","Liebe"]]; }`;

  test('"create an artifact with this code" + an HTML dump still routes to data', () => {
    expect(classifyMessage(`Create an artifact with this code. Send me the link.\n${PAGE}`).topic).toBe('data');
  });

  test('a fenced code block does not steal routing from the prose ask', () => {
    const msg = 'Create an artifact with this code:\n```html\n' + PAGE + '\n```';
    expect(classifyMessage(msg).topic).toBe('data');
  });

  test('prose-level coding asks are unaffected', () => {
    expect(classifyMessage('Refactor the typescript module and add a unit test').topic).toBe('coding');
  });
});

describe('classifyMessage — an unclosed snippet must not eat the prose after it', () => {
  const ASK = 'Also, please refactor the typescript module and add unit tests.';

  test('prose after a truncated <script> still routes', () => {
    expect(classifyMessage(`<div><script>function foo(){ var a = 1;\n\n${ASK}`).topic).toBe('coding');
  });

  test('prose after a forgotten closing fence still routes', () => {
    expect(classifyMessage('```js\nfunction foo(){}\n\n' + ASK).topic).toBe('coding');
  });

  test('a closed <script> containing a blank line is still fully stripped', () => {
    const msg = 'Create an artifact with this code.\n<script>\nconst a = 1;\n\nfunction render(){ return html`x` }\n</script>';
    expect(classifyMessage(msg).topic).toBe('data');
  });
});
