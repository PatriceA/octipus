import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withInlineUiLines } from '../dist/tools/sessions.js';

test('an interactive-answer marker becomes the readable line; other text is untouched', () => {
  const text = 'Here it is:\n[[octi-ui:11111111-1111-4111-8111-111111111111|Loan calculator]]\nDone. [[not a marker]]';
  assert.equal(
    withInlineUiLines(text),
    'Here it is:\n▸ Interactive answer “Loan calculator” — open this conversation in the Octipus web app to use it.\nDone. [[not a marker]]',
  );
  assert.equal(withInlineUiLines('plain'), 'plain');
});
