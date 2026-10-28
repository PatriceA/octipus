import { expect, it } from 'vitest';
import { effectiveShellTimeout, PIPELINE_SHELL_TIMEOUT_FLOOR_MS } from './index';

it('raises short limits to the floor only inside a pipeline stage (#55)', () => {
  expect(effectiveShellTimeout(undefined, undefined)).toBe(30_000);
  expect(effectiveShellTimeout(5_000, {})).toBe(5_000);
  expect(effectiveShellTimeout(60_000, { pipelineId: 'p' })).toBe(PIPELINE_SHELL_TIMEOUT_FLOOR_MS);
  expect(effectiveShellTimeout(undefined, { pipelineId: 'p' })).toBe(PIPELINE_SHELL_TIMEOUT_FLOOR_MS);
  expect(effectiveShellTimeout(3_600_000, { pipelineId: 'p' })).toBe(3_600_000);
});
