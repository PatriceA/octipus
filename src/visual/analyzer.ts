import { LiteLLMClient } from '../models/litellm-client';
import { logger } from '../utils/logger';
import type { ScreenshotResult, ElementInfo } from './screenshot';

export interface AnalysisResult {
  description: string;
  elements: AnalyzedElement[];
  issues: UIIssue[];
  suggestions: string[];
  accessibility: AccessibilityReport;
}

export interface AnalyzedElement {
  selector: string;
  description: string;
  purpose: string;
  state: 'normal' | 'error' | 'disabled' | 'loading' | 'hidden';
}

export interface UIIssue {
  type: 'error' | 'warning' | 'info';
  category: 'visual' | 'functional' | 'accessibility' | 'performance';
  description: string;
  selector?: string;
  suggestion: string;
}

export interface AccessibilityReport {
  score: number; // 0-100
  issues: Array<{
    type: string;
    description: string;
    wcagLevel: 'A' | 'AA' | 'AAA';
  }>;
}

export interface ComparisonResult {
  similarity: number; // 0-100
  differences: Array<{
    region: { x: number; y: number; width: number; height: number };
    description: string;
    severity: 'major' | 'minor' | 'cosmetic';
  }>;
  summary: string;
}

/**
 * Visual analyzer using vision models
 */
export class VisualAnalyzer {
  private llmClient: LiteLLMClient;
  private visionModel: string;
  private log = logger.child({ component: 'visual-analyzer' });

  constructor(llmClient: LiteLLMClient, visionModel: string = 'gpt-4-vision-preview') {
    this.llmClient = llmClient;
    this.visionModel = visionModel;
  }

  /**
   * Analyze screenshot with vision model
   */
  async analyze(screenshot: ScreenshotResult, context?: string): Promise<AnalysisResult> {
    this.log.debug({ url: screenshot.url }, 'Analyzing screenshot');

    const base64Image = screenshot.image.toString('base64');
    const mimeType = screenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png';

    const systemPrompt = `You are a UI/UX expert analyzing web application screenshots.
Provide detailed analysis including:
1. Overall description of the UI
2. Identified elements and their purposes
3. Any visual or functional issues
4. Accessibility concerns
5. Improvement suggestions

Respond in JSON format with this structure:
{
  "description": "Overall description",
  "elements": [{"selector": "css selector", "description": "what it is", "purpose": "what it does", "state": "normal|error|disabled|loading|hidden"}],
  "issues": [{"type": "error|warning|info", "category": "visual|functional|accessibility|performance", "description": "issue description", "selector": "affected element", "suggestion": "how to fix"}],
  "suggestions": ["improvement suggestions"],
  "accessibility": {"score": 0-100, "issues": [{"type": "issue type", "description": "description", "wcagLevel": "A|AA|AAA"}]}
}`;

    const userPrompt = context
      ? `Analyze this screenshot. Context: ${context}`
      : 'Analyze this screenshot and identify any issues or areas for improvement.';

    const now = new Date();
    const response = await this.llmClient.complete({
      model: this.visionModel,
      messages: [
        { role: 'system', content: systemPrompt, timestamp: now },
        {
          role: 'user',
          content: `${userPrompt}\n\n[Image: data:${mimeType};base64,${base64Image}]`,
          timestamp: now,
        },
      ],
      temperature: 0.3,
    });

    try {
      const content = response.content || '{}';
      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
      const result = JSON.parse(jsonStr);

      this.log.info({
        issueCount: result.issues?.length || 0,
        accessibilityScore: result.accessibility?.score,
      }, 'Analysis complete');

      return result;
    } catch (error) {
      this.log.error({ error }, 'Failed to parse analysis result');
      return {
        description: 'Unable to analyze screenshot',
        elements: [],
        issues: [],
        suggestions: [],
        accessibility: { score: 0, issues: [] },
      };
    }
  }

  /**
   * Compare two screenshots
   */
  async compare(
    screenshot1: ScreenshotResult,
    screenshot2: ScreenshotResult,
    context?: string
  ): Promise<ComparisonResult> {
    this.log.debug('Comparing screenshots');

    const base64Image1 = screenshot1.image.toString('base64');
    const base64Image2 = screenshot2.image.toString('base64');
    const mimeType = screenshot1.format === 'jpeg' ? 'image/jpeg' : 'image/png';

    const systemPrompt = `You are a visual regression testing expert comparing two screenshots.
Identify differences between the images and assess their impact.

Respond in JSON format:
{
  "similarity": 0-100,
  "differences": [{"region": {"x": 0, "y": 0, "width": 100, "height": 100}, "description": "what changed", "severity": "major|minor|cosmetic"}],
  "summary": "brief summary of changes"
}`;

    const userPrompt = context
      ? `Compare these two screenshots. Context: ${context}. The first image is the "before" state and the second is the "after" state.`
      : 'Compare these two screenshots. The first image is the "before" state and the second is the "after" state. Identify any visual differences.';

    const now = new Date();
    const response = await this.llmClient.complete({
      model: this.visionModel,
      messages: [
        { role: 'system', content: systemPrompt, timestamp: now },
        {
          role: 'user',
          content: `${userPrompt}\n\n[Image 1: data:${mimeType};base64,${base64Image1}]\n[Image 2: data:${mimeType};base64,${base64Image2}]`,
          timestamp: now,
        },
      ],
      temperature: 0.3,
    });

    try {
      const content = response.content || '{}';
      const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
      return JSON.parse(jsonStr);
    } catch (error) {
      this.log.error({ error }, 'Failed to parse comparison result');
      return {
        similarity: 0,
        differences: [],
        summary: 'Unable to compare screenshots',
      };
    }
  }

  /**
   * Find element by description
   */
  async findElement(
    screenshot: ScreenshotResult,
    description: string
  ): Promise<{ selector: string; confidence: number } | null> {
    const base64Image = screenshot.image.toString('base64');
    const mimeType = screenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png';

    const systemPrompt = `You are a UI element locator. Given a screenshot and a description of an element, identify the most likely CSS selector for that element.

Respond in JSON format:
{
  "selector": "css selector",
  "confidence": 0-100,
  "alternativeSelectors": ["other possible selectors"]
}

If the element cannot be found, respond with {"selector": null, "confidence": 0}`;

    const now = new Date();
    const response = await this.llmClient.complete({
      model: this.visionModel,
      messages: [
        { role: 'system', content: systemPrompt, timestamp: now },
        {
          role: 'user',
          content: `Find the element: "${description}"\n\n[Image: data:${mimeType};base64,${base64Image}]`,
          timestamp: now,
        },
      ],
      temperature: 0.2,
    });

    try {
      const content = response.content || '{}';
      const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
      const result = JSON.parse(jsonStr);

      if (result.selector) {
        return { selector: result.selector, confidence: result.confidence };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Generate test scenarios based on UI
   */
  async generateTestScenarios(screenshot: ScreenshotResult): Promise<string[]> {
    const base64Image = screenshot.image.toString('base64');
    const mimeType = screenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png';

    const systemPrompt = `You are a QA engineer. Given a screenshot of a web application, generate a list of test scenarios that should be tested.

Respond in JSON format:
{
  "scenarios": [
    "Test scenario description 1",
    "Test scenario description 2"
  ]
}`;

    const now = new Date();
    const response = await this.llmClient.complete({
      model: this.visionModel,
      messages: [
        { role: 'system', content: systemPrompt, timestamp: now },
        {
          role: 'user',
          content: `Generate test scenarios for this page.\n\n[Image: data:${mimeType};base64,${base64Image}]`,
          timestamp: now,
        },
      ],
      temperature: 0.5,
    });

    try {
      const content = response.content || '{}';
      const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
      const result = JSON.parse(jsonStr);
      return result.scenarios || [];
    } catch {
      return [];
    }
  }

  /**
   * Describe what action to take for a given goal
   */
  async describeAction(
    screenshot: ScreenshotResult,
    goal: string
  ): Promise<{ action: string; selector: string; value?: string }[]> {
    const base64Image = screenshot.image.toString('base64');
    const mimeType = screenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png';

    const systemPrompt = `You are a web automation expert. Given a screenshot and a goal, describe the sequence of actions needed to achieve that goal.

Respond in JSON format:
{
  "actions": [
    {"action": "click|type|select|scroll|wait", "selector": "css selector", "value": "optional value for type/select"}
  ]
}`;

    const now = new Date();
    const response = await this.llmClient.complete({
      model: this.visionModel,
      messages: [
        { role: 'system', content: systemPrompt, timestamp: now },
        {
          role: 'user',
          content: `Goal: ${goal}\n\n[Image: data:${mimeType};base64,${base64Image}]`,
          timestamp: now,
        },
      ],
      temperature: 0.3,
    });

    try {
      const content = response.content || '{}';
      const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
      const result = JSON.parse(jsonStr);
      return result.actions || [];
    } catch {
      return [];
    }
  }
}
