/** Session presentation shared by both terminal surfaces. */
import type { TUI } from '@/tui-kit';
import { inlineUiFallbackText } from '@/shared/inline-ui/fence';
import type { AgentSessionEvent, GatewayAdapter, ToolEventState } from './gateway-adapter';
import type { MessagesPane } from './components/messages-pane';
import type { StatusBar, CumulativeStats } from './components/status-bar';
import type { ActivityLine } from './components/activity-line';
import type { SubagentPanel } from './components/subagent-panel';
import { applyToolEvent, newToolGroup, type ToolGroupItem } from './components/tool-group';
import type { TranscriptItem } from './components/messages-pane';

/** What the surface knows about an event's place in the running turn (`OctipusTuiApp.trackTurn`). */
export interface TurnContext {
  /** A late answer of a turn that already ended: shown, but the live reply of the next turn stays. */
  stale?: boolean;
  /** This error ended the running turn: what it left half-streamed goes. */
  endsTurn?: boolean;
}

/**
 * How long a streaming reply of `length` characters waits between redraws.
 * Every redraw renders the whole reply's Markdown again, so a long one is
 * redrawn less often; a short one, every delta.
 */
export function liveRedrawInterval(length: number): number {
  return length < 8192 ? 0 : Math.min(250, Math.round(length / 512));
}

/** Progress message ids remembered to drop repeats (a reconnect replays them): the newest this many. */
export const SEEN_MESSAGE_IDS_KEPT = 1024;

export class ChatSessionPresenter {
  cumulative: CumulativeStats = { tokens: 0, cost: 0, turns: 0 };
  lastPlanSummary: string | null = null;
  private refreshingPlan = false;
  private discoveredPlan = false;
  private connected = false;
  private activeAgentRole: string | null = null;
  private activeAgentModel: string | undefined;
  private streamText = '';
  private streamIteration = -1;
  /** When the live reply was last handed to the pane, and the redraw waiting for its interval. */
  private liveShownAt = 0;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  /** This turn's tool calls: one transcript item, created by the first call. */
  private toolGroup: ToolGroupItem | null = null;
  private seenMessageIds = new Set<string>();
  constructor(private readonly tui: TUI, private readonly adapter: GatewayAdapter,
    private readonly messages: MessagesPane, private readonly status: StatusBar,
    private readonly activity: ActivityLine, private readonly subagents: SubagentPanel,
    private readonly pushMessage: (role: 'user' | 'assistant' | 'system', text: string) => void) {}

  dispose(): void { this.activity.dispose(); this.cancelLive(); }
  reset(): void {
    this.seenMessageIds.clear();
    this.refreshingPlan = false;
    this.discoveredPlan = false;
    this.clearStream(); this.toolGroup = null; this.subagents.reset(); this.cumulative = { tokens: 0, cost: 0, turns: 0 };
    this.status.setStats(this.cumulative); this.status.setContext(null);
    this.activeAgentModel = undefined; this.status.setModel(null);
    this.lastPlanSummary = null; this.status.setPlan(null); this.status.setPlanDetails(null);
  }
  handleEvent(event: AgentSessionEvent, turn: TurnContext = {}): boolean {
    switch (event.kind) {
      case 'status':
        if (event.status === 'connected') {
          if (!this.connected) this.subagents.reset();
          // Once on connect; after that the gateway says when the plan changes (`plan.updated`).
          this.adapter.sendCommand('work-plan-status');
        } else {
          this.refreshingPlan = false;
          this.lastPlanSummary = 'Unavailable · connection lost';
          this.status.setPlan(this.lastPlanSummary);
          this.clearStream(); this.activity.setThinking(null); this.activity.setTool(null);
        }
        this.connected = event.status === 'connected';
        this.status.setStatus(event.status); this.tui.requestRender();
        return false; // surfaces still handle reconnect/history
      case 'plan.updated':
        this.adapter.sendCommand('work-plan-status');
        return true;
      case 'command.result':
        if (event.name === 'work-plan-status') {
          const summary = typeof event.result === 'string' ? event.result : '';
          const plan = event.error ? 'Unavailable' : summary || null;
          if (plan !== this.lastPlanSummary) {
            this.lastPlanSummary = plan; this.status.setPlan(plan);
            if (!event.error && summary && (!this.discoveredPlan || this.status.isPlanExpanded())) {
              this.refreshingPlan = true;
              if (!this.discoveredPlan) this.status.setPlanDetails('Loading plan…');
              this.discoveredPlan = true;
              this.adapter.sendCommand('work-plan');
            }
            this.tui.requestRender();
          }
          return true;
        }
        if (event.name === 'work-plan' && event.error) {
          if (this.refreshingPlan && !this.status.isPlanExpanded()) { this.refreshingPlan = false; return true; }
          this.refreshingPlan = false;
          this.status.setPlanDetails('Plan details unavailable. Use /work-plan to retry.');
          this.tui.requestRender();
        }
        if (event.name === 'work-plan' && !event.error && typeof event.result === 'string') {
          if (this.refreshingPlan && !this.status.isPlanExpanded()) { this.refreshingPlan = false; return true; }
          this.status.setPlanDetails(event.result);
          if (!this.refreshingPlan) this.pushMessage('assistant', event.result);
          this.refreshingPlan = false;
          this.tui.requestRender();
          return true;
        }
        return false;
      case 'delta':
        // A new iteration means the previous text was reasoning before a tool
        // call, not the reply: keep it as a folded thinking item so the trail
        // stays visible without reading as an answer, then start the next live block.
        if (event.iteration !== this.streamIteration) {
          this.flushReasoning();
          this.streamIteration = event.iteration;
        }
        this.streamText += event.delta;
        this.showLive();
        return true;
      case 'message':
        if (event.messageId && this.seenMessageIds.has(event.messageId)) return true;
        if (event.messageId) {
          this.seenMessageIds.add(event.messageId);
          // A Set iterates in insertion order: the first is the oldest. A long session no longer grows it without bound.
          if (this.seenMessageIds.size > SEEN_MESSAGE_IDS_KEPT) this.seenMessageIds.delete(this.seenMessageIds.values().next().value as string);
        }
        if (event.role === 'assistant' && !event.progress && !turn.stale) { this.clearStream(); this.toolGroup = null; }
        this.pushMessage(event.role, event.content);
        return true;
      case 'agent.start':
        // A subagent gets its own row in the panel; the activity line stays
        // the ROOT agent's, so a fan-out doesn't make the main indicator
        // flicker between children.
        if (event.subagent && event.nodeId) {
          // A worker is announced twice (its `agent.spawned` and its swarm node): one row.
          if (!this.subagents.has(event.nodeId)) this.subagents.start(event.nodeId, event.role, event.model);
          this.tui.requestRender();
          return true;
        }
        // Not the root and nothing to show it under: its "Agent spawned" line is all there is.
        if (!event.root) return true;
        // Start with iteration 0 so a long-running agent isn't silent
        // between spawn and its first iteration tick (the worker emits
        // iteration_update at the TOP of each loop iteration).
        this.activeAgentRole = event.role;
        this.activeAgentModel = event.model || undefined;
        if (this.activeAgentModel) this.status.setModel(this.activeAgentModel);
        this.clearStream(); // a new turn: whatever a failed one left half-streamed is not history
        this.toolGroup = null;
        this.activity.setThinking({ role: event.role, iter: 0, model: this.activeAgentModel });
        return true;
      case 'agent.iteration':
        if (this.subagents.has(event.agentId)) {
          this.subagents.iteration(event.agentId, event.iteration);
          this.tui.requestRender();
          return true;
        }
        this.activity.setThinking({
          role: this.activeAgentRole ?? 'agent',
          iter: event.iteration,
          model: this.activeAgentModel,
        });
        return true;
      case 'identity':
        // Single source of truth for the badge: a login, a logout, and a
        // session the gateway rejected all arrive here.
        this.status.setUser(event.user);
        this.tui.requestRender();
        return true;
      case 'session.stats':
        // Authoritative: the backend counted every agent in this session from
        // the cost log, so it REPLACES the live sum accumulated below (which
        // only sees the completions this client was sent).
        this.cumulative = {
          tokens: event.stats.tokens,
          cost: event.stats.cost,
          turns: this.cumulative.turns,
        };
        this.status.setStats(this.cumulative);
        this.status.setContext(
          event.stats.contextTokens
            ? { used: event.stats.contextTokens, window: event.stats.contextWindow }
            : null,
        );
        this.tui.requestRender();
        return true;
      case 'agent.end':
        if (this.subagents.has(event.nodeId)) {
          this.subagents.end(event.nodeId as string);
          this.cumulative = {
            tokens: this.cumulative.tokens + event.stats.tokens,
            cost: this.cumulative.cost + event.stats.cost,
            turns: this.cumulative.turns,
          };
          this.status.setStats(this.cumulative);
          this.tui.requestRender();
          return true;
        }
        if (!event.root) {
          // A worker the panel never saw finishing: count what it spent, leave
          // the root's activity row and live reply alone.
          this.cumulative = { ...this.cumulative, tokens: this.cumulative.tokens + event.stats.tokens, cost: this.cumulative.cost + event.stats.cost };
          this.status.setStats(this.cumulative);
          this.tui.requestRender();
          return true;
        }
        this.cumulative = {
          tokens: this.cumulative.tokens + event.stats.tokens,
          cost: this.cumulative.cost + event.stats.cost,
          turns: this.cumulative.turns + 1,
        };
        this.status.setStats(this.cumulative);
        this.activity.setTool(null);
        this.activity.setThinking(null);
        this.activeAgentRole = null;
        this.activeAgentModel = undefined;
        this.clearStream();
        this.toolGroup = null;
        this.tui.requestRender();
        return true;
      case 'tool':
        // A subagent's tool calls belong to its row, not to the transcript —
        // three children fanning out used to bury the conversation under
        // somebody else's `→ websearch`.
        if (this.subagents.has(event.agentId)) {
          this.subagents.tool(event.agentId as string, event.tool);
          this.tui.requestRender();
          return true;
        }
        this.activity.setTool(event.tool);
        this.recordTool(event.tool);
        return true;
      case 'error':
        // A rate limit or an expired approval is not the turn failing: the
        // live reply and the activity row stay.
        if (turn.endsTurn) { this.activity.setThinking(null); this.activity.setTool(null); this.clearStream(); }
        this.pushMessage('system', `Error: ${event.message}`);
        return true;
      case 'chat.error':
        // The turn's own `error` frame (or the surface) says what failed.
        if (!turn.stale) { this.activity.setThinking(null); this.activity.setTool(null); this.clearStream(); this.tui.requestRender(); }
        return true;
      case 'expert':
        this.status.setExpert(event.expertId);
        this.tui.requestRender();
        return true;
      default: return false;
    }
  }
  /**
   * Hand the live reply to the pane now, or — a long reply, redrawn lately —
   * once its redraw interval is over (`liveRedrawInterval`). The last delta
   * is always drawn: the timer draws whatever streamed by then.
   */
  private showLive(): void {
    const wait = liveRedrawInterval(this.streamText.length) - (Date.now() - this.liveShownAt);
    if (wait <= 0) { this.drawLive(); return; }
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => { this.liveTimer = null; this.drawLive(); }, wait);
    this.liveTimer.unref?.();
  }

  private drawLive(): void {
    this.cancelLive();
    this.liveShownAt = Date.now();
    // A streaming interactive answer shows as its plain line, not as markup.
    this.messages.setLive(this.streamText ? inlineUiFallbackText(this.streamText) : null);
    this.tui.requestRender();
  }

  private cancelLive(): void {
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; }
  }

  /** The live text so far becomes a folded thinking item; a later delta of the same iteration starts a new live block. */
  private flushReasoning(): void {
    if (!this.streamText.trim()) return;
    this.pushItem({ kind: 'thinking', text: this.streamText, expanded: this.messages.getDetail() });
    this.streamText = '';
    this.cancelLive();
    this.messages.setLive(null);
  }

  private clearStream(): void {
    this.cancelLive();
    this.streamText = '';
    this.streamIteration = -1;
    this.messages.setLive(null);
  }

  /** A root agent tool event: into this turn's tool group, which the first call puts in the transcript. */
  private recordTool(tool: ToolEventState): void {
    // What streamed before the call was the reasoning that led to it: keep it
    // above the group, as a thinking item, not under it as a live reply.
    this.flushReasoning();
    const group = this.toolGroup ?? (this.toolGroup = { ...newToolGroup(), expanded: this.messages.getDetail() });
    applyToolEvent(group, tool);
    // The first call puts the group in the transcript (again, after /clear emptied it).
    if (this.messages.update(group)) this.tui.requestRender();
    else this.pushItem(group);
  }

  /** Add an item, following the end only when the reader is already there (as `pushMessage` does). */
  private pushItem(item: TranscriptItem): void {
    const wasAtBottom = this.messages.getScrollOffset() === 0;
    this.messages.pushItem(item);
    if (wasAtBottom) this.messages.scrollToBottom();
    this.tui.requestRender();
  }

}
