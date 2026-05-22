import type { MessageClassification } from './types';

// Keyword sets for fast classification
const CASUAL_PATTERNS = [
  /^(hi|hello|hey|greetings|good\s*(morning|afternoon|evening)|howdy|sup)\b/i,
  /^(thanks|thank\s*you|thx|cheers)\b/i,
  /^(bye|goodbye|see\s*you|later|cya)\b/i,
  /^(how\s*are\s*you|what'?s\s*up|how'?s\s*it\s*going)/i,
  /^(yes|no|ok|okay|sure|nope|yep|yeah)\b/i,
  // Capability questions ("help", "what can you do") are NOT casual —
  // they need the orchestrator so the answer reflects the actual
  // configured experts/tools, not whatever the persona LLM guesses.
  /^what\s+is\s+the\s+\w+\s+of\b/i,  // "What is the capital of France?"
  /^(can you|could you)\s+(explain|tell|clarify)/i,  // "Can you explain that?"
  /\b(more detail|elaborate|clarify)\b/i,  // Follow-up requests
  /^who\s+(am\s+i|are\s+you)\b/i,  // Identity questions
  /^what\s+(do\s+you\s+know\s+about\s+me|is\s+my\s+name)\b/i,  // Self-knowledge questions
  /^(what\s+time|what\s+day|what\s+date|what'?s\s+the\s+(time|date|day))\b/i,  // Time/date questions
  // Trivial arithmetic / one-shot factual questions — no specialist needed
  /^\s*(what\s+is\s+|what'?s\s+|how\s+much\s+is\s+)?\d[\d\s+\-*/×÷.()]*\??\s*$/i,  // "2+2", "what is 2+2?"
  /^(say|repeat|tell\s+me)\s+(the\s+word|"|')/i,  // "Say the word ok", 'Repeat "x"'
  /^(define|what\s+does)\s+\w+\s+(mean|stand\s+for)/i,  // "Define X", "What does X mean"
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
  qa: [
    'qa', 'qa/validate', 'qa validate',
    'validate', 'validate wiring', 'validate pipeline', 'validate artifact',
    'art_toolbox_validate',
    'run tests', 'run the tests', 'test suite', 'unit tests',
    'integration tests', 'e2e tests', 'verify', 'verification',
    'sanity check', 'sanity-check',
  ],
  data: [
    'database schema', 'data model', 'data pipeline', 'etl',
    'sql query', 'migration', 'row-level security', 'multi-tenant',
    'data warehouse', 'analytics', 'data engineering',
    'postgresql', 'mysql', 'mongodb', 'redis schema',
    'live artifact', 'create artifact', 'dashboard', 'rss feed',
    'data source', 'hosted dashboard', 'news feed',
    'artifact toolbox', 'toolbox tool', 'art_collect', 'art_widget',
    'art_transform', 'art_export', 'art_toolbox_list',
    'art_toolbox_describe', 'art_toolbox_search', 'describe artifact',
    'list artifact tools', 'list the artifact', 'artifact tools',
    // Dashboard / chart / export wording — strong "build an artifact"
    // signal that QA would never legitimately own.
    'create a dashboard', 'create a artifact', 'create an artifact',
    'dashboard artifact', 'pie chart', 'bar chart', 'line chart',
    'csv export', 'export csv', 'label count', 'label-count',
    'group by label',
  ],
  writing: [
    'documentation', 'api documentation', 'write docs', 'readme',
    'technical writing', 'user guide', 'tutorial',
    'write a report', 'changelog',
    'write comprehensive', 'write detailed', 'error codes',
  ],
  architecture: [
    'architecture', 'system design', 'design the system', 'requirements',
    'technical specification', 'component diagram', 'data flow',
    'api contract', 'adr', 'architecture decision', 'design document',
    'system architecture', 'microservices', 'monolith', 'event-driven',
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
    'call me', 'phone call', 'ring me', 'dial', 'voice call',
    'call at', 'call to', 'make a call', 'give me a call',
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
  // Strip backticked identifiers before keyword matching. Names like
  // `qa-issues` are user-chosen labels, not intent — without this the bare
  // `qa` keyword (and other short tokens) get spurious matches inside
  // arbitrary identifiers and pull routing to the wrong specialist.
  const stripped = message.replace(/`[^`]*`/g, ' ');
  const normalized = stripped.trim().toLowerCase();
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

  // Short messages without task keywords are likely casual.
  // Bumped from 3 → 6 words: covers things like "what is 2+2 one word",
  // "say the word ok", "tell me a joke" — all of which were previously
  // falling through to 'ambiguous' and getting routed to a coding agent.
  if (normalized.split(/\s+/).length <= 6) {
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
