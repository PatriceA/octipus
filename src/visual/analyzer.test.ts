import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import * as modelRegistry from '@/models/model-registry';
import { VisualAnalyzer } from './analyzer';

// analyzer.ts dynamically imports getModelRegistry to resolve the vision model.
// Spy the accessor (NOT mock.module, which is process-global in bun and leaks
// the stub into unrelated suites — see the bun mock.module leak note) so it
// restores cleanly after this file runs.
const registrySpy = vi.spyOn(modelRegistry, 'getModelRegistry').mockReturnValue({
  getModelForTopic: async (topic: string) =>
    topic === 'vision' ? { modelId: 'mock-vision-model' } : null,
} as unknown as ReturnType<typeof modelRegistry.getModelRegistry>);

afterAll(() => registrySpy.mockRestore());

describe('VisualAnalyzer', () => {
  let mockLlmClient: any;
  let analyzer: VisualAnalyzer;
  
  const mockScreenshot: any = {
    image: Buffer.from('mock-image'),
    format: 'png',
    url: 'https://example.com'
  };

  beforeEach(() => {
    mockLlmClient = {
      complete: vi.fn(async () => ({ content: '{}' }))
    };
    analyzer = new VisualAnalyzer(mockLlmClient as any);
  });

  test('resolves vision model automatically', async () => {
    mockLlmClient.complete.mockResolvedValueOnce({ 
      content: JSON.stringify({ description: 'test', elements: [], issues: [], suggestions: [], accessibility: { score: 100, issues: [] } })
    });
    
    await analyzer.analyze(mockScreenshot);
    expect(mockLlmClient.complete).toHaveBeenCalled();
    const callArgs = mockLlmClient.complete.mock.calls[0][0];
    expect(callArgs.model).toBe('mock-vision-model');
  });

  test('throws a clear error when no vision model is bound', async () => {
    // Exercise the real null-guard branch in resolveVisionModel (not the mock's
    // forced happy path): registry returns no model for the 'vision' topic.
    registrySpy.mockReturnValueOnce({
      getModelForTopic: async () => null,
    } as unknown as ReturnType<typeof modelRegistry.getModelRegistry>);
    await expect(analyzer.analyze(mockScreenshot)).rejects.toThrow(/No vision model configured/);
  });

  test('analyze parses valid JSON response', async () => {
    mockLlmClient.complete.mockResolvedValueOnce({ 
      content: '```json\n{"description": "A test page", "elements": [], "issues": [], "suggestions": [], "accessibility": {"score": 90, "issues": []}}\n```'
    });
    
    const result = await analyzer.analyze(mockScreenshot);
    expect(result.description).toBe('A test page');
    expect(result.accessibility.score).toBe(90);
  });

  test('analyze handles invalid JSON gracefully', async () => {
    mockLlmClient.complete.mockResolvedValueOnce({ content: 'Not a JSON' });
    
    const result = await analyzer.analyze(mockScreenshot);
    expect(result.description).toBe('Unable to analyze screenshot');
    expect(result.elements).toEqual([]);
  });

  test('compare parses valid JSON response', async () => {
    mockLlmClient.complete.mockResolvedValueOnce({ 
      content: '{"similarity": 95, "differences": [], "summary": "Almost identical"}'
    });
    
    const result = await analyzer.compare(mockScreenshot, mockScreenshot);
    expect(result.similarity).toBe(95);
    expect(result.summary).toBe('Almost identical');
  });

  test('compare handles invalid JSON gracefully', async () => {
    mockLlmClient.complete.mockResolvedValueOnce({ content: 'Invalid' });
    
    const result = await analyzer.compare(mockScreenshot, mockScreenshot);
    expect(result.similarity).toBe(0);
    expect(result.summary).toBe('Unable to compare screenshots');
  });

  test('findElement returns selector on success', async () => {
    mockLlmClient.complete.mockResolvedValueOnce({ 
      content: '{"selector": "#submit-btn", "confidence": 99}'
    });
    
    const result = await analyzer.findElement(mockScreenshot, 'Submit button');
    expect(result).not.toBeNull();
    expect(result?.selector).toBe('#submit-btn');
    expect(result?.confidence).toBe(99);
  });

  test('findElement returns null when not found', async () => {
    mockLlmClient.complete.mockResolvedValueOnce({ 
      content: '{"selector": null, "confidence": 0}'
    });
    
    const result = await analyzer.findElement(mockScreenshot, 'Non-existent element');
    expect(result).toBeNull();
  });

  test('generateTestScenarios returns string array', async () => {
    mockLlmClient.complete.mockResolvedValueOnce({ 
      content: '{"scenarios": ["Click login", "Verify error message"]}'
    });
    
    const result = await analyzer.generateTestScenarios(mockScreenshot);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('Click login');
  });

  test('describeAction returns actions array', async () => {
    mockLlmClient.complete.mockResolvedValueOnce({ 
      content: '{"actions": [{"action": "click", "selector": "#btn"}]}'
    });
    
    const result = await analyzer.describeAction(mockScreenshot, 'Click the button');
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('click');
  });
});
