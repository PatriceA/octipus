/**
 * Model conformance testing — public API.
 */

// Test fixtures
export {
  ADD_NUMBERS_TOOL,
  TINY_RED_PNG_BASE64,
  TINY_RED_PNG_DATA_URI,
  PROMPTS,
  validateBasicCompletion,
  validateMultiTurn,
  validateFrenchResponse,
  validateToolCall,
  validateJSON,
  validateEmbeddings,
} from './test-fixtures';

// Conformance runner
export {
  runConformanceTests,
  getTestCaseNames,
  getTestCases,
  capabilitiesFromModel,
} from './conformance';

// Types
export type {
  ModelCapabilities,
  ConformanceTestCase,
  TestContext,
  ConformanceResult,
  ConformanceReport,
  RunConformanceOptions,
} from './conformance';
