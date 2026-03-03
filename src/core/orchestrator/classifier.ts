import type { MessageClassification } from './types';

// Keyword sets for fast classification
const CASUAL_PATTERNS = [
  /^(hi|hello|hey|greetings|good\s*(morning|afternoon|evening)|howdy|sup)\b/i,
  /^(thanks|thank\s*you|thx|cheers)\b/i,
  /^(bye|goodbye|see\s*you|later|cya)\b/i,
  /^(how\s*are\s*you|what'?s\s*up|how'?s\s*it\s*going)/i,
  /^(yes|no|ok|okay|sure|nope|yep|yeah)\b/i,
  /^(help|what\s*can\s*you\s*do)\b/i,
];

const TASK_KEYWORDS: Record<string, string[]> = {
  development: [
    'implement', 'build', 'create', 'develop', 'code', 'write', 'add',
    'refactor', 'fix', 'debug', 'deploy', 'setup', 'configure', 'install',
    'migrate', 'upgrade', 'integrate', 'api', 'endpoint', 'database',
    'frontend', 'backend', 'component', 'feature', 'function', 'class',
    'module', 'service', 'test', 'unit test', 'dockerfile', 'docker',
    'ci/cd', 'pipeline', 'webpack', 'typescript', 'javascript', 'python',
    'rust', 'go', 'java', 'sql', 'css', 'html', 'react', 'next.js',
    'vue', 'angular', 'node', 'bun', 'npm', 'package',
  ],
  research: [
    'research', 'investigate', 'find out', 'look up', 'search for',
    'compare', 'evaluate', 'analyze', 'what is', 'how does', 'why does',
    'explain', 'summarize', 'review', 'assess', 'benchmark', 'survey',
    'learn about', 'study', 'explore', 'alternatives', 'best practices',
    'architecture', 'design pattern', 'pros and cons',
  ],
  communication: [
    'email', 'gmail', 'inbox', 'mail', 'send email', 'read email',
    'calendar', 'schedule', 'meeting', 'appointment', 'event',
    'contacts', 'address book',
    'drive', 'docs', 'sheets', 'slides', 'google docs',
    'outlook', 'office 365', 'microsoft 365', 'teams',
    'compose', 'reply', 'forward', 'draft',
  ],
  general: [
    'run', 'execute', 'check', 'monitor', 'update', 'clean', 'organize',
    'automate', 'schedule', 'notify', 'track', 'manage', 'generate',
    'convert', 'transform', 'parse', 'process', 'extract', 'scrape',
  ],
};

const APPROVAL_PATTERNS = [
  /^(approve|yes|go\s*ahead|proceed|confirm|accept|lgtm|ship\s*it)\b/i,
  /^(deny|reject|no|stop|cancel|abort|don'?t)\b/i,
];

/**
 * Classify a message using keyword heuristics.
 * Returns 'ambiguous' when confidence is too low for a definitive answer.
 */
export function classifyMessage(message: string): MessageClassification {
  const normalized = message.trim().toLowerCase();

  // Check for approval/denial responses
  for (const pattern of APPROVAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return { type: 'approval', confidence: 0.9 };
    }
  }

  // Check casual patterns (greetings, thanks, etc.)
  for (const pattern of CASUAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return { type: 'casual', confidence: 0.9 };
    }
  }

  // Short messages without task keywords are likely casual
  if (normalized.split(/\s+/).length <= 3) {
    // Check if any task keywords match even in short messages
    const hasTaskKeyword = Object.values(TASK_KEYWORDS)
      .flat()
      .some(kw => normalized.includes(kw));

    if (!hasTaskKeyword) {
      return { type: 'casual', confidence: 0.6 };
    }
  }

  // Score each task category
  let bestCategory: string | null = null;
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(TASK_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (normalized.includes(keyword)) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  // High confidence task
  if (bestScore >= 2 && bestCategory) {
    const suggestedPipeline = bestCategory as MessageClassification['suggestedPipeline'];
    return {
      type: 'task',
      confidence: Math.min(bestScore / 4, 1),
      suggestedPipeline,
      topic: bestCategory,
    };
  }

  // Single keyword match — moderate confidence
  if (bestScore === 1 && bestCategory) {
    return {
      type: 'task',
      confidence: 0.4,
      suggestedPipeline: bestCategory as MessageClassification['suggestedPipeline'],
      topic: bestCategory,
    };
  }

  // Can't determine — let the LLM decide
  return { type: 'ambiguous', confidence: 0.2 };
}
