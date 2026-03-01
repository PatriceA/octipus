export { ScreenshotCapture } from './screenshot';
export type {
  ScreenshotOptions,
  ScreenshotResult,
  ElementInfo,
  BrowserType,
} from './screenshot';

export { VisualAnalyzer } from './analyzer';
export type {
  AnalysisResult,
  AnalyzedElement,
  UIIssue,
  AccessibilityReport,
  ComparisonResult,
} from './analyzer';

export { VisualDebugger } from './debugger';
export type {
  DebugSession,
  DebugAction,
  DebugFeedback,
} from './debugger';

import { VisualDebugger } from './debugger';
import { LiteLLMClient } from '../models/litellm-client';
import type { BrowserType } from './screenshot';

/**
 * Factory function to create a visual debugger instance
 */
export function createVisualDebugger(
  llmClient: LiteLLMClient,
  options: {
    browserType?: BrowserType;
    visionModel?: string;
  } = {}
): VisualDebugger {
  return new VisualDebugger(
    llmClient,
    options.browserType || 'chromium',
    options.visionModel || 'gpt-4-vision-preview'
  );
}
