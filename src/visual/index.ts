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
export async function createVisualDebugger(
  llmClient: LiteLLMClient,
  options: {
    browserType?: BrowserType;
    visionModel?: string;
  } = {}
): Promise<VisualDebugger> {
  let visionModel = options.visionModel;
  if (!visionModel) {
    const { getModelRegistry } = await import('../models/model-registry');
    const m = await getModelRegistry().getModelForTopic('vision');
    if (!m) {
      throw new Error('No model mapped to topic "vision". Assign one in the Models page.');
    }
    visionModel = m.modelId;
  }
  return new VisualDebugger(llmClient, options.browserType || 'chromium', visionModel);
}
