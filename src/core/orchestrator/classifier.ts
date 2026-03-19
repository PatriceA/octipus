import type { MessageClassification } from './types';

// Keyword sets for fast classification
const CASUAL_PATTERNS = [
  /^(hi|hello|hey|greetings|good\s*(morning|afternoon|evening)|howdy|sup)\b/i,
  /^(thanks|thank\s*you|thx|cheers)\b/i,
  /^(bye|goodbye|see\s*you|later|cya)\b/i,
  /^(how\s*are\s*you|what'?s\s*up|how'?s\s*it\s*going)/i,
  /^(yes|no|ok|okay|sure|nope|yep|yeah)\b/i,
  /^(help|what\s*can\s*you\s*do)\b/i,
  /^what\s+is\s+the\s+\w+\s+of\b/i,  // "What is the capital of France?"
  /^(can you|could you)\s+(explain|tell|clarify)/i,  // "Can you explain that?"
  /\b(more detail|elaborate|clarify)\b/i,  // Follow-up requests
];

const TASK_KEYWORDS: Record<string, string[]> = {
  development: [
    'implement', 'write code', 'develop', 'program',
    'refactor', 'fix bug', 'fix the bug', 'debug', 'add feature',
    'api endpoint', 'frontend', 'backend', 'component',
    'function', 'class', 'module', 'unit test', 'test suite',
    'webpack', 'typescript', 'javascript', 'python',
    'rust', 'java', 'css', 'html', 'react', 'next.js',
    'vue', 'angular', 'npm', 'package.json',
    'commit the', 'pull request', 'merge request', 'git status',
    'git diff', 'git log', 'git push', 'git commit',
  ],
  research: [
    'research', 'investigate', 'summary', 'find out', 'look up', 'search for',
    'search the web', 'search online', 'web search',
    'compare', 'evaluate', 'how does', 'why does',
    'summarize', 'assess', 'benchmark', 'survey',
    'learn about', 'study', 'explore', 'alternatives', 'best practices',
    'design pattern', 'pros and cons',
    'scrape', 'hacker news', 'front page', 'top stories',
    'open github', 'open http', 'latest release', 'release notes',
    'latest version', 'tell me about', 'features of',
  ],
  devops: [
    'docker', 'dockerfile', 'container', 'kubernetes', 'k8s',
    'ci/cd', 'pipeline', 'github actions', 'deploy', 'deployment',
    'nginx', 'reverse proxy', 'ssl', 'tls', 'load balancer',
    'infrastructure', 'terraform', 'ansible', 'helm',
    'server', 'cluster', 'scaling', 'auto-scaling',
    'monitoring', 'grafana', 'prometheus',
  ],
  security: [
    'security', 'vulnerability', 'audit', 'owasp', 'penetration',
    'threat model', 'sql injection', 'xss', 'csrf',
    'authentication flow', 'access control', 'encryption',
    'security review', 'cve', 'exploit', 'hardening',
  ],
  data: [
    'database schema', 'data model', 'data pipeline', 'etl',
    'sql query', 'migration', 'row-level security', 'multi-tenant',
    'data warehouse', 'analytics', 'data engineering',
    'postgresql', 'mysql', 'mongodb', 'redis schema',
  ],
  writing: [
    'documentation', 'api documentation', 'write docs', 'readme',
    'technical writing', 'user guide', 'tutorial',
    'write a report', 'changelog',
    'write comprehensive', 'write detailed', 'error codes',
  ],
  design: [
    'ui design', 'ux design', 'user interface', 'user experience',
    'accessibility', 'color contrast', 'typography', 'wireframe',
    'mockup', 'prototype', 'landing page design', 'responsive design',
  ],
  finance: [
    'cost-benefit', 'budget', 'financial analysis', 'pricing',
    'roi', 'cost analysis', 'billing', 'invoice', 'revenue',
    'cost comparison', 'cost optimization',
    'analyze the cost', 'migrating from', 'migrate from',
  ],
  communication: [
    'email', 'gmail', 'inbox', 'mail', 'send email', 'read email',
    'calendar', 'meeting', 'appointment', 'event',
    'contacts', 'address book',
    'drive', 'docs', 'sheets', 'slides', 'google docs',
    'outlook', 'office 365', 'microsoft 365',
    'compose', 'reply', 'forward', 'draft',
  ],
  automation: [
    'schedule', 'scheduled task', 'recurring task', 'cron', 'hook',
    'create a task', 'create a schedule', 'every day', 'every morning',
    'every hour', 'daily task', 'weekly task', 'automate', 'automation',
    'remind me', 'alert me', 'send me every', 'cron job',
    'when an agent', 'event-triggered', 'trigger',
  ],
  general: [
    'run', 'execute', 'check', 'update', 'clean', 'organize',
    'notify', 'track', 'manage', 'generate',
    'convert', 'transform', 'parse', 'process', 'extract',
    'list', 'show me', 'what are', 'what experts', 'what tools',
    'mcp', 'available', 'connected', 'channels',
    'upload', 'document', 'knowledge base',
    'send a message', 'send message', 'telegram', 'slack',
    'screenshot', 'take a screenshot', 'browser', 'my browser',
    'tabs', 'open tabs',
  ],
};

const APPROVAL_PATTERNS = [
  /^(approve|yes|go\s*ahead|proceed|confirm|accept|lgtm|ship\s*it)\b/i,
  /^(deny|reject|no|stop|cancel|abort|don'?t)\b/i,
];

/**
 * Score message complexity based on length, structure, and keyword analysis.
 */
function scoreComplexity(message: string): 'simple' | 'moderate' | 'complex' {
  const words = message.split(/\s+/).length;
  const sentences = message.split(/[.!?]+/).filter(Boolean).length;
  const hasCodeBlock = /```/.test(message);
  const hasMultipleParts = /\b(and also|additionally|then|after that|as well as|plus|moreover)\b/i.test(message);
  const hasComplexVerbs = /\b(analyze|compare|design|architect|implement|refactor|optimize|debug|migrate|integrate)\b/i.test(message);

  let score = 0;
  if (words > 50) score++;
  if (words > 150) score++;
  if (sentences > 3) score++;
  if (hasCodeBlock) score++;
  if (hasMultipleParts) score++;
  if (hasComplexVerbs) score++;

  if (score <= 1) return 'simple';
  if (score <= 3) return 'moderate';
  return 'complex';
}

/**
 * Classify a message using keyword heuristics.
 * Returns 'ambiguous' when confidence is too low for a definitive answer.
 */
export function classifyMessage(message: string): MessageClassification {
  const normalized = message.trim().toLowerCase();
  const complexity = scoreComplexity(message);

  // Check for approval/denial responses
  for (const pattern of APPROVAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return { type: 'approval', confidence: 0.9, complexity: 'simple' };
    }
  }

  // Check casual patterns (greetings, thanks, etc.)
  // Only treat as casual if the message is short — "hi" is casual,
  // "hi, give me my gmail messages" is a task with a greeting prefix.
  const wordCount = normalized.split(/\s+/).length;
  for (const pattern of CASUAL_PATTERNS) {
    if (pattern.test(normalized)) {
      // Greeting-type patterns only casual if short; knowledge/follow-up patterns can be longer
      const isGreeting = /^(hi|hello|hey|thanks|bye|yes|no|ok|help)\b/i.test(normalized);
      if (!isGreeting || wordCount <= 5) {
        return { type: 'casual', confidence: 0.9, complexity: 'simple' };
      }
    }
  }

  // Short messages without task keywords are likely casual
  if (normalized.split(/\s+/).length <= 3) {
    // Check if any task keywords match even in short messages
    const hasTaskKeyword = Object.values(TASK_KEYWORDS)
      .flat()
      .some(kw => normalized.includes(kw));

    if (!hasTaskKeyword) {
      return { type: 'casual', confidence: 0.6, complexity: 'simple' };
    }
  }

  // Score each task category
  // Multi-word keywords get bonus weight (more specific = more reliable)
  // Single-word keywords use word boundary matching to avoid substring false positives
  let bestCategory: string | null = null;
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(TASK_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      const isMultiWord = keyword.includes(' ');
      if (isMultiWord) {
        // Multi-word: exact substring match is fine, give bonus weight
        if (normalized.includes(keyword)) {
          score += 1.5;
        }
      } else {
        // Single-word: use word boundary to avoid "develop" matching "developments"
        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
        if (regex.test(normalized)) {
          score += 1;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  // High confidence task
  if (bestScore >= 1.5 && bestCategory) {
    return {
      type: 'task',
      confidence: Math.min(bestScore / 4, 1),
      complexity,
      topic: bestCategory,
    };
  }

  // Single keyword match — only classify as task if the message has enough context
  // (a lone word like "test" or "run" isn't a real task request)
  if (bestScore === 1 && bestCategory) {
    if (wordCount <= 2) {
      return { type: 'casual', confidence: 0.8, complexity: 'simple' };
    }
    return {
      type: 'task',
      confidence: 0.4,
      complexity,
      topic: bestCategory,
    };
  }

  // Can't determine — let the LLM decide
  return { type: 'ambiguous', confidence: 0.2, complexity };
}
