/**
 * Agent evaluation harness — public API.
 */

export type {
  EvalSuite,
  EvalTest,
  Assertion,
  AssertionType,
  EvalResult,
  AssertionResult,
  EvalSuiteResult,
  EvalTestResult,
  EvalRunnerOptions,
  TestExecutionContext,
  TestStatus,
} from './types';

export { loadSuites, loadSuiteFromFile } from './loader';
export { runTest, runSuite, runAllSuites } from './runner';
export { evaluateAssertion, evaluateAllAssertions } from './assertions';
export { reportToConsole, reportDetailedToConsole, saveResults, toJSON } from './reporter';
