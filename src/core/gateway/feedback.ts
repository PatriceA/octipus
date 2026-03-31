import { coreLogger } from '@/utils/logger';
import type { GatewayEvent } from './protocol';

// ── Emoji Mappings ────────────────────────────────────────────────

export interface ReactionState {
  messageId: string;
  currentEmoji: string | null;
  isTerminal: boolean;
}

const AGENT_STATE_EMOJIS: Record<string, string> = {
  'orchestrator.classifying': '🤔',
  'orchestrator.status': '🧠',
  'agent.spawned': '🧠',
  'agent.completed': '✅',
  'agent.failed': '❌',
  'agent.stopped': '🛑',
  'permission.request': '⏳',
};

const TOOL_EMOJIS: Record<string, string> = {
  filesystem: '📖',
  shell: '💻',
  git: '💻',
  browser: '🔍',
  'browser-ext': '🔍',
  websearch: '🔍',
  knowledge: '📖',
  docker: '🐳',
  github: '💻',
  gitlab: '💻',
  messaging: '💬',
  documents: '📄',
};

const TERMINAL_EMOJIS = new Set(['✅', '❌', '🛑']);

// ── Feedback Manager ──────────────────────────────────────────────

/**
 * Maps agent lifecycle events to emoji reactions.
 * Debounces intermediate states (700ms) and applies terminal states immediately.
 */
export class FeedbackManager {
  private reactions: Map<string, ReactionState> = new Map();
  private debounceTimers: Map<string, Timer> = new Map();
  private stallDetector: StallDetector;

  // Callback to actually send the reaction (channel-specific)
  private onReaction?: (messageId: string, emoji: string) => void;

  constructor(options?: { onReaction?: (messageId: string, emoji: string) => void }) {
    this.onReaction = options?.onReaction;
    this.stallDetector = new StallDetector({
      onStall: (agentId, level) => {
        const emoji = level === 'hard' ? '😬' : '😐';
        // Find message for this agent and apply stall emoji
        for (const [msgId, state] of this.reactions) {
          if (!state.isTerminal) {
            this.applyReaction(msgId, emoji, false);
          }
        }
      },
    });
  }

  /**
   * Process a gateway event and emit appropriate emoji reactions.
   */
  handleEvent(event: GatewayEvent): void {
    const messageId = (event.payload as any)?.messageId || (event.payload as any)?.originalMessageId;
    if (!messageId) return;

    // Check for tool call events
    if (event.type === 'agent.event') {
      const data = event.payload as any;
      if (data?.type === 'tool_call' && data?.toolName) {
        const emoji = TOOL_EMOJIS[data.toolName] || '🔧';
        this.applyReaction(messageId, emoji, false);
        return;
      }
    }

    // Map event type to emoji
    const emoji = AGENT_STATE_EMOJIS[event.type];
    if (!emoji) return;

    const isTerminal = TERMINAL_EMOJIS.has(emoji);
    this.applyReaction(messageId, emoji, isTerminal);

    // Update stall detector
    const agentId = (event.payload as any)?.agentId;
    if (agentId) {
      if (isTerminal) {
        this.stallDetector.clear(agentId);
      } else {
        this.stallDetector.recordProgress(agentId);
      }
    }
  }

  private applyReaction(messageId: string, emoji: string, isTerminal: boolean): void {
    // Cancel any pending debounce
    const timer = this.debounceTimers.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(messageId);
    }

    const current = this.reactions.get(messageId);
    if (current?.isTerminal) return; // Don't overwrite terminal states

    if (isTerminal) {
      // Apply immediately
      this.reactions.set(messageId, { messageId, currentEmoji: emoji, isTerminal: true });
      this.onReaction?.(messageId, emoji);
    } else {
      // Debounce intermediate states at 700ms
      this.debounceTimers.set(messageId, setTimeout(() => {
        this.debounceTimers.delete(messageId);
        const cur = this.reactions.get(messageId);
        if (cur?.isTerminal) return;
        this.reactions.set(messageId, { messageId, currentEmoji: emoji, isTerminal: false });
        this.onReaction?.(messageId, emoji);
      }, 700));
    }
  }

  /**
   * Get current reaction state for a message.
   */
  getReaction(messageId: string): ReactionState | undefined {
    return this.reactions.get(messageId);
  }

  /**
   * Clear all state.
   */
  destroy(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.reactions.clear();
    this.stallDetector.destroy();
  }
}

// ── Stall Detector ────────────────────────────────────────────────

export type StallLevel = 'soft' | 'hard';

/**
 * Detects stalled agents (no progress for 10s = soft, 30s = hard).
 * Runs on a 5-second check interval per active agent.
 */
export class StallDetector {
  private lastProgress: Map<string, number> = new Map();
  private checkTimer: Timer | null = null;
  private onStall?: (agentId: string, level: StallLevel) => void;
  private notifiedStalls: Map<string, StallLevel> = new Map();

  static readonly SOFT_THRESHOLD_MS = 10_000;
  static readonly HARD_THRESHOLD_MS = 30_000;
  static readonly CHECK_INTERVAL_MS = 5_000;

  constructor(options?: { onStall?: (agentId: string, level: StallLevel) => void }) {
    this.onStall = options?.onStall;
    this.checkTimer = setInterval(() => this.check(), StallDetector.CHECK_INTERVAL_MS);
  }

  /**
   * Record progress for an agent (resets stall timer).
   */
  recordProgress(agentId: string): void {
    this.lastProgress.set(agentId, Date.now());
    this.notifiedStalls.delete(agentId);
  }

  /**
   * Check a specific agent's stall state.
   */
  getStallLevel(agentId: string): StallLevel | null {
    const last = this.lastProgress.get(agentId);
    if (!last) return null;

    const elapsed = Date.now() - last;
    if (elapsed > StallDetector.HARD_THRESHOLD_MS) return 'hard';
    if (elapsed > StallDetector.SOFT_THRESHOLD_MS) return 'soft';
    return null;
  }

  /**
   * Remove an agent from tracking (on completion/failure).
   */
  clear(agentId: string): void {
    this.lastProgress.delete(agentId);
    this.notifiedStalls.delete(agentId);
  }

  private check(): void {
    const now = Date.now();
    for (const [agentId, lastTime] of this.lastProgress) {
      const elapsed = now - lastTime;
      let level: StallLevel | null = null;

      if (elapsed > StallDetector.HARD_THRESHOLD_MS) level = 'hard';
      else if (elapsed > StallDetector.SOFT_THRESHOLD_MS) level = 'soft';

      if (level && this.notifiedStalls.get(agentId) !== level) {
        this.notifiedStalls.set(agentId, level);
        this.onStall?.(agentId, level);
      }
    }
  }

  destroy(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.lastProgress.clear();
    this.notifiedStalls.clear();
  }
}
