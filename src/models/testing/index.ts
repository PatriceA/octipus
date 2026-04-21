/**
 * Model conformance testing — public API.
 */


// Types
export type {
  ConformanceReport,
  ConformanceResult,
  ConformanceTestCase,
  ModelCapabilities,
  RunConformanceOptions,
  TestContext,
} from './conformance';

// Conformance runner
export {
  capabilitiesFromModel,
  getTestCaseNames,
  getTestCases,
  runConformanceTests,
} from './conformance';
// Test fixtures
export {
  ADD_NUMBERS_TOOL,
  PROMPTS,
  TINY_RED_PNG_BASE64,
  TINY_RED_PNG_DATA_URI,
  validateBasicCompletion,
  validateEmbeddings,
  validateFrenchResponse,
  validateJSON,
  validateMultiTurn,
  validateToolCall,
} from './test-fixtures';
