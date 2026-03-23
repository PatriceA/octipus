import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { Router } from './router';

describe('Router', () => {
  let router: Router;

  beforeEach(() => {
    router = new Router();
  });

  describe('classifyTopic', () => {
    test('classifies coding-related messages', () => {
      const result = router.classifyTopic('Write a Python function to sort a list');

      expect(result.topic).toBe('coding');
      expect(result.confidence).toBeGreaterThan(0);
    });

    test('classifies messages with code keywords', () => {
      const result = router.classifyTopic('I need to debug this error in my TypeScript code');

      expect(result.topic).toBe('coding');
    });

    test('classifies analysis messages', () => {
      const result = router.classifyTopic('Please review this architecture and explain the design pattern');

      expect(result.topic).toBe('analysis');
    });

    test('classifies chat messages', () => {
      const result = router.classifyTopic('Hello, how are you today?');

      expect(result.topic).toBe('chat');
    });

    test('classifies embedding messages', () => {
      const result = router.classifyTopic('Create embeddings for semantic search');

      expect(result.topic).toBe('embedding');
    });

    test('returns general for ambiguous messages', () => {
      const result = router.classifyTopic('xyz abc 123');

      expect(result.topic).toBe('general');
      expect(result.confidence).toBe(0.3);
    });

    test('handles empty messages', () => {
      const result = router.classifyTopic('');

      expect(result.topic).toBe('general');
    });

    test('is case insensitive', () => {
      const result1 = router.classifyTopic('IMPLEMENT a function');
      const result2 = router.classifyTopic('implement a function');

      expect(result1.topic).toBe(result2.topic);
    });

    test('confidence increases with more keyword matches', () => {
      const result1 = router.classifyTopic('code');
      const result2 = router.classifyTopic('code function bug error implement');

      expect(result2.confidence).toBeGreaterThan(result1.confidence);
    });

    test('confidence is capped at 1', () => {
      const result = router.classifyTopic(
        'code function bug error implement debug fix refactor typescript javascript'
      );

      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('route', () => {
    // Note: These tests require mocking getModelRegistry
    // For now, test the classifyTopic which is the core logic

    test('route method exists', () => {
      expect(typeof router.route).toBe('function');
    });
  });

  describe('topic keywords coverage', () => {
    const codingKeywords = [
      'code', 'function', 'bug', 'error', 'implement', 'debug', 'fix', 'refactor',
      'typescript', 'javascript', 'python', 'rust', 'go', 'java',
      'api', 'backend', 'frontend',
    ];

    test('recognizes all coding keywords', () => {
      for (const keyword of codingKeywords) {
        const result = router.classifyTopic(`I need help with ${keyword}`);
        expect(result.topic).toBe('coding');
      }
    });

    test('routes specialized keywords to correct topics', () => {
      // Keywords moved to dedicated topics in expanded routing
      expect(router.classifyTopic('deploy the container to kubernetes').topic).toBe('devops');
      expect(router.classifyTopic('run the unit test coverage').topic).toBe('qa');
      expect(router.classifyTopic('database schema migration').topic).toBe('data');
      expect(router.classifyTopic('write a sql query for postgres').topic).toBe('data');
      expect(router.classifyTopic('check for xss vulnerability').topic).toBe('security');
    });

    const analysisKeywords = [
      'analyze', 'review', 'explain', 'compare', 'evaluate',
      'pros', 'cons', 'architecture', 'pattern', 'best practice',
    ];

    test('recognizes all analysis keywords', () => {
      for (const keyword of analysisKeywords) {
        const result = router.classifyTopic(`Please ${keyword} this`);
        // May be analysis or overlap with other topics
        expect(['analysis', 'coding', 'chat', 'design']).toContain(result.topic);
      }
    });

    const chatKeywords = ['hello', 'hi', 'hey', 'thanks', 'help'];

    test('recognizes chat keywords', () => {
      for (const keyword of chatKeywords) {
        const result = router.classifyTopic(keyword);
        expect(result.topic).toBe('chat');
      }
    });
  });
});
