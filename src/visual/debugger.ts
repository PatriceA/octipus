import { ScreenshotCapture, type ScreenshotResult, type BrowserType } from './screenshot';
import { VisualAnalyzer, type AnalysisResult, type ComparisonResult } from './analyzer';
import { LiteLLMClient } from '../models/litellm-client';
import { logger } from '../utils/logger';

export interface DebugSession {
  id: string;
  url: string;
  startTime: number;
  screenshots: ScreenshotResult[];
  analyses: AnalysisResult[];
  actions: DebugAction[];
}

export interface DebugAction {
  type: 'navigate' | 'click' | 'type' | 'screenshot' | 'analyze' | 'compare';
  timestamp: number;
  details: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface DebugFeedback {
  issue: string;
  selector?: string;
  expectedBehavior: string;
  actualBehavior: string;
  suggestedFix?: string;
  codeContext?: string;
}

/**
 * Visual debugger for interactive UI debugging and testing
 */
export class VisualDebugger {
  private capture: ScreenshotCapture;
  private analyzer: VisualAnalyzer;
  private sessions: Map<string, DebugSession> = new Map();
  private currentSession: DebugSession | null = null;
  private log = logger.child({ component: 'visual-debugger' });

  constructor(
    llmClient: LiteLLMClient,
    browserType: BrowserType = 'chromium',
    visionModel: string = 'gpt-4-vision-preview'
  ) {
    this.capture = new ScreenshotCapture(browserType, true);
    this.analyzer = new VisualAnalyzer(llmClient, visionModel);
  }

  /**
   * Start a new debug session
   */
  async startSession(url: string): Promise<string> {
    await this.capture.init();

    const session: DebugSession = {
      id: crypto.randomUUID(),
      url,
      startTime: Date.now(),
      screenshots: [],
      analyses: [],
      actions: [],
    };

    this.sessions.set(session.id, session);
    this.currentSession = session;

    await this.navigate(url);

    this.log.info({ sessionId: session.id, url }, 'Debug session started');
    return session.id;
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string): Promise<ScreenshotResult> {
    if (!this.currentSession) {
      throw new Error('No active debug session');
    }

    const action: DebugAction = {
      type: 'navigate',
      timestamp: Date.now(),
      details: { url },
    };

    try {
      await this.capture.navigate(url);
      const screenshot = await this.captureAndAnalyze();
      action.result = { success: true };
      return screenshot;
    } catch (error) {
      action.error = (error as Error).message;
      throw error;
    } finally {
      this.currentSession.actions.push(action);
    }
  }

  /**
   * Click element
   */
  async click(selector: string): Promise<ScreenshotResult> {
    if (!this.currentSession) {
      throw new Error('No active debug session');
    }

    const action: DebugAction = {
      type: 'click',
      timestamp: Date.now(),
      details: { selector },
    };

    try {
      await this.capture.click(selector);
      await this.capture.waitForNavigation().catch(() => {}); // May not navigate
      const screenshot = await this.captureAndAnalyze();
      action.result = { success: true };
      return screenshot;
    } catch (error) {
      action.error = (error as Error).message;
      throw error;
    } finally {
      this.currentSession.actions.push(action);
    }
  }

  /**
   * Type text into element
   */
  async type(selector: string, text: string): Promise<ScreenshotResult> {
    if (!this.currentSession) {
      throw new Error('No active debug session');
    }

    const action: DebugAction = {
      type: 'type',
      timestamp: Date.now(),
      details: { selector, text: text.substring(0, 50) },
    };

    try {
      await this.capture.type(selector, text);
      const screenshot = await this.captureAndAnalyze();
      action.result = { success: true };
      return screenshot;
    } catch (error) {
      action.error = (error as Error).message;
      throw error;
    } finally {
      this.currentSession.actions.push(action);
    }
  }

  /**
   * Capture screenshot and analyze
   */
  private async captureAndAnalyze(): Promise<ScreenshotResult> {
    const screenshot = await this.capture.captureWithElements();
    this.currentSession!.screenshots.push(screenshot);

    const analysis = await this.analyzer.analyze(screenshot);
    this.currentSession!.analyses.push(analysis);

    return screenshot;
  }

  /**
   * Get latest analysis
   */
  getLatestAnalysis(): AnalysisResult | null {
    if (!this.currentSession || this.currentSession.analyses.length === 0) {
      return null;
    }
    return this.currentSession.analyses[this.currentSession.analyses.length - 1];
  }

  /**
   * Compare current state with previous screenshot
   */
  async compareWithPrevious(): Promise<ComparisonResult | null> {
    if (!this.currentSession || this.currentSession.screenshots.length < 2) {
      return null;
    }

    const screenshots = this.currentSession.screenshots;
    const before = screenshots[screenshots.length - 2];
    const after = screenshots[screenshots.length - 1];

    return this.analyzer.compare(before, after);
  }

  /**
   * Execute a sequence of actions toward a goal
   */
  async executeGoal(goal: string, maxSteps: number = 10): Promise<{ success: boolean; steps: string[] }> {
    if (!this.currentSession) {
      throw new Error('No active debug session');
    }

    const steps: string[] = [];
    let currentScreenshot = this.currentSession.screenshots[this.currentSession.screenshots.length - 1];

    if (!currentScreenshot) {
      currentScreenshot = await this.captureAndAnalyze();
    }

    for (let i = 0; i < maxSteps; i++) {
      // Ask analyzer what action to take
      const actions = await this.analyzer.describeAction(currentScreenshot, goal);

      if (actions.length === 0) {
        this.log.info('No more actions needed');
        break;
      }

      const action = actions[0];
      steps.push(`${action.action}: ${action.selector}${action.value ? ` = "${action.value}"` : ''}`);

      try {
        switch (action.action) {
          case 'click':
            currentScreenshot = await this.click(action.selector);
            break;
          case 'type':
            if (action.value) {
              currentScreenshot = await this.type(action.selector, action.value);
            }
            break;
          case 'scroll':
            await this.capture.evaluate(() => window.scrollBy(0, 300));
            currentScreenshot = await this.captureAndAnalyze();
            break;
          case 'wait':
            await Bun.sleep(1000);
            currentScreenshot = await this.captureAndAnalyze();
            break;
          default:
            this.log.warn({ action: action.action }, 'Unknown action');
        }

        // Check if goal is achieved
        const analysis = this.getLatestAnalysis();
        if (analysis?.description.toLowerCase().includes('success') ||
            analysis?.description.toLowerCase().includes('complete')) {
          return { success: true, steps };
        }
      } catch (error) {
        this.log.error({ error, action }, 'Action failed');
        steps.push(`ERROR: ${(error as Error).message}`);
        break;
      }
    }

    return { success: false, steps };
  }

  /**
   * Generate debug feedback for coding agent
   */
  async generateFeedback(issueDescription?: string): Promise<DebugFeedback[]> {
    if (!this.currentSession) {
      throw new Error('No active debug session');
    }

    const analysis = this.getLatestAnalysis();
    if (!analysis) {
      return [];
    }

    const feedbacks: DebugFeedback[] = [];

    for (const issue of analysis.issues) {
      if (issue.type === 'error' || issue.type === 'warning') {
        feedbacks.push({
          issue: issue.description,
          selector: issue.selector,
          expectedBehavior: issue.suggestion,
          actualBehavior: issue.description,
          suggestedFix: issue.suggestion,
        });
      }
    }

    // Add accessibility issues
    for (const a11yIssue of analysis.accessibility.issues) {
      feedbacks.push({
        issue: `Accessibility: ${a11yIssue.type}`,
        expectedBehavior: `WCAG ${a11yIssue.wcagLevel} compliance`,
        actualBehavior: a11yIssue.description,
        suggestedFix: `Fix ${a11yIssue.type} to meet WCAG ${a11yIssue.wcagLevel}`,
      });
    }

    return feedbacks;
  }

  /**
   * Run visual regression test
   */
  async runRegressionTest(
    baselineScreenshot: ScreenshotResult,
    threshold: number = 95
  ): Promise<{ passed: boolean; similarity: number; differences: string[] }> {
    const currentScreenshot = await this.capture.capture();
    const comparison = await this.analyzer.compare(baselineScreenshot, currentScreenshot);

    const passed = comparison.similarity >= threshold;
    const differences = comparison.differences.map(d =>
      `[${d.severity}] ${d.description} at (${d.region.x}, ${d.region.y})`
    );

    return { passed, similarity: comparison.similarity, differences };
  }

  /**
   * Generate Playwright test code from session
   */
  generateTestCode(): string {
    if (!this.currentSession) {
      return '// No active session';
    }

    const lines: string[] = [
      "import { test, expect } from '@playwright/test';",
      '',
      `test('Visual debug session ${this.currentSession.id}', async ({ page }) => {`,
    ];

    for (const action of this.currentSession.actions) {
      switch (action.type) {
        case 'navigate':
          lines.push(`  await page.goto('${action.details.url}');`);
          break;
        case 'click':
          lines.push(`  await page.click('${action.details.selector}');`);
          break;
        case 'type':
          lines.push(`  await page.fill('${action.details.selector}', '${action.details.text}');`);
          break;
      }
    }

    lines.push('});');
    return lines.join('\n');
  }

  /**
   * Get session summary
   */
  getSessionSummary(): object | null {
    if (!this.currentSession) return null;

    return {
      id: this.currentSession.id,
      url: this.currentSession.url,
      duration: Date.now() - this.currentSession.startTime,
      screenshotCount: this.currentSession.screenshots.length,
      actionCount: this.currentSession.actions.length,
      issues: this.currentSession.analyses.flatMap(a => a.issues),
      latestAccessibilityScore: this.currentSession.analyses[this.currentSession.analyses.length - 1]?.accessibility.score,
    };
  }

  /**
   * End debug session
   */
  async endSession(): Promise<DebugSession | null> {
    if (!this.currentSession) return null;

    const session = this.currentSession;
    this.currentSession = null;

    await this.capture.close();

    this.log.info({
      sessionId: session.id,
      duration: Date.now() - session.startTime,
      actions: session.actions.length,
    }, 'Debug session ended');

    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): DebugSession | undefined {
    return this.sessions.get(sessionId);
  }
}
