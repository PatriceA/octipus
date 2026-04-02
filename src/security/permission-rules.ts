/**
 * Rule-based permission engine inspired by claw-code-parity.
 *
 * Rules use the syntax: tool_name(matcher)
 *   - tool_name    — matches the tool ID (e.g., "shell", "filesystem", "docker")
 *   - matcher      — matches the tool action/argument:
 *     - *          — wildcard, matches anything
 *     - exact      — exact string match (e.g., "git status")
 *     - prefix:*   — prefix match (e.g., "git:*" matches "git status", "git push", etc.)
 *
 * Rules are evaluated in order: deny → allow → ask → default.
 *
 * Configuration is loaded from the settings service (key: "permissions.rules").
 */

import { securityLogger } from '@/utils/logger';

export type RuleDecision = 'allow' | 'deny' | 'ask';

export interface PermissionRule {
  pattern: string;      // e.g., "shell(git:*)" or "filesystem(*)"
  decision: RuleDecision;
}

export interface PermissionRulesConfig {
  allow?: string[];  // e.g., ["shell(git:*)", "filesystem(*)"]
  deny?: string[];   // e.g., ["shell(rm -rf:*)", "shell(dd:*)"]
  ask?: string[];    // e.g., ["shell(sudo:*)", "docker(*)"]
}

interface ParsedRule {
  toolId: string;
  matchType: 'any' | 'exact' | 'prefix';
  matchValue: string; // empty for 'any', exact string, or prefix string
  decision: RuleDecision;
  raw: string;
}

/**
 * Parse a rule pattern like "shell(git:*)" into structured form.
 */
function parseRule(pattern: string, decision: RuleDecision): ParsedRule | null {
  // Format: toolId(matcher) or just toolId (matches any)
  const match = pattern.match(/^([^(]+?)(?:\(([^)]*)\))?$/);
  if (!match) {
    securityLogger.warn({ pattern }, 'Invalid permission rule pattern');
    return null;
  }

  const toolId = match[1].trim();
  const matcher = match[2]?.trim();

  if (!matcher || matcher === '*' || matcher === '') {
    return { toolId, matchType: 'any', matchValue: '', decision, raw: pattern };
  }

  if (matcher.endsWith(':*')) {
    return { toolId, matchType: 'prefix', matchValue: matcher.slice(0, -2), decision, raw: pattern };
  }

  return { toolId, matchType: 'exact', matchValue: matcher, decision, raw: pattern };
}

/**
 * Extract the matchable value from tool call context.
 * Tries common argument keys: command, path, file_path, url, query.
 */
function extractMatchValue(action: string, context?: Record<string, unknown>): string {
  if (!context) return action;
  const value = (
    context.command || context.path || context.file_path || context.filePath ||
    context.url || context.query || context.message
  ) as string | undefined;
  return value || action;
}

export class PermissionRuleEngine {
  private rules: ParsedRule[] = [];

  /**
   * Load rules from configuration.
   */
  load(config: PermissionRulesConfig): void {
    this.rules = [];

    // Deny rules first (highest priority)
    for (const pattern of config.deny || []) {
      const rule = parseRule(pattern, 'deny');
      if (rule) this.rules.push(rule);
    }

    // Allow rules second
    for (const pattern of config.allow || []) {
      const rule = parseRule(pattern, 'allow');
      if (rule) this.rules.push(rule);
    }

    // Ask rules last
    for (const pattern of config.ask || []) {
      const rule = parseRule(pattern, 'ask');
      if (rule) this.rules.push(rule);
    }

    securityLogger.info({ ruleCount: this.rules.length }, 'Permission rules loaded');
  }

  /**
   * Evaluate rules against a tool call. Returns the first matching rule's decision,
   * or null if no rule matches (caller should fall back to default behavior).
   */
  evaluate(toolId: string, action: string, context?: Record<string, unknown>): { decision: RuleDecision; rule: string } | null {
    const matchValue = extractMatchValue(action, context);

    for (const rule of this.rules) {
      // Tool ID must match
      if (rule.toolId !== toolId && rule.toolId !== '*') continue;

      // Check matcher
      switch (rule.matchType) {
        case 'any':
          return { decision: rule.decision, rule: rule.raw };

        case 'exact':
          if (matchValue === rule.matchValue) {
            return { decision: rule.decision, rule: rule.raw };
          }
          break;

        case 'prefix':
          if (matchValue.startsWith(rule.matchValue)) {
            return { decision: rule.decision, rule: rule.raw };
          }
          break;
      }
    }

    return null; // No rule matched
  }

  getRuleCount(): number {
    return this.rules.length;
  }
}

// Singleton
let engineInstance: PermissionRuleEngine | null = null;

export function getPermissionRuleEngine(): PermissionRuleEngine {
  if (!engineInstance) {
    engineInstance = new PermissionRuleEngine();
  }
  return engineInstance;
}

/**
 * Initialize the rule engine from settings.
 */
export async function initPermissionRules(): Promise<void> {
  try {
    const { getSettingsService } = await import('@/config/settings-service');
    const settings = getSettingsService();
    const rulesConfig = await settings.get('permissions.rules') as PermissionRulesConfig | null;

    const engine = getPermissionRuleEngine();

    if (rulesConfig) {
      engine.load(rulesConfig);
    } else {
      // Default rules — sensible defaults
      engine.load({
        allow: [
          'shell(git:*)',       // Git commands are always safe
          'shell(ls:*)',        // Listing is safe
          'shell(cat:*)',       // Reading is safe
          'shell(echo:*)',      // Echo is safe
          'filesystem(*)',      // Filesystem tool has its own guards
          'knowledge(*)',       // Knowledge operations are safe
          'websearch(*)',       // Web search is safe
        ],
        deny: [
          'shell(rm -rf /:*)',  // Never delete root
          'shell(dd if=/dev:*)', // Never raw disk write
          'shell(mkfs:*)',      // Never format
          'shell(:(){ :|:&};:)', // Fork bomb
        ],
        ask: [
          'shell(sudo:*)',      // Escalation needs approval
          'shell(docker:*)',    // Container ops need approval
          'shell(systemctl:*)', // Service management needs approval
        ],
      });
    }
  } catch (err) {
    securityLogger.debug({ err }, 'Permission rules initialization skipped');
  }
}
