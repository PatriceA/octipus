/** Session presentation shared by both terminal surfaces. */
import type { TUI } from '@mariozechner/pi-tui';
import type { AgentSessionEvent, GatewayAdapter } from './gateway-adapter';
import type { MessagesPane } from './components/messages-pane';
import type { StatusBar, CumulativeStats } from './components/status-bar';
import type { ActivityLine } from './components/activity-line';
import type { SubagentPanel } from './components/subagent-panel';

export class ChatSessionPresenter {
  cumulative: CumulativeStats = { tokens: 0, cost: 0, turns: 0 };
  lastPlanSummary: string | null = null;
  private refreshingPlan = false;
  private connected = false;
  private planPoll: ReturnType<typeof setInterval> | null = null;
  private activeAgentRole: string | null = null;
  private activeAgentModel: string | undefined;
  private streamText = '';
  private streamIteration = -1;
  private lastStreamedTool: string | null = null;
  constructor(private readonly tui: TUI, private readonly adapter: GatewayAdapter,
    private readonly messages: MessagesPane, private readonly status: StatusBar,
    private readonly activity: ActivityLine, private readonly subagents: SubagentPanel,
    private readonly pushMessage: (role: 'user' | 'assistant' | 'system', text: string) => void) {}

  dispose(): void { if (this.planPoll) clearInterval(this.planPoll); this.planPoll = null; this.activity.dispose(); }
  reset(): void {
    this.refreshingPlan = false;
    this.clearStream(); this.subagents.reset(); this.cumulative = { tokens: 0, cost: 0, turns: 0 };
    this.status.setStats(this.cumulative); this.status.setContext(null);
    this.lastPlanSummary = null; this.status.setPlan(null); this.status.setPlanDetails(null);
  }
  handleEvent(event: AgentSessionEvent): boolean {
    switch (event.kind) {
      case 'status':
        if (this.planPoll) clearInterval(this.planPoll);
        this.planPoll = null;
        if (event.status === 'connected') {
          if (!this.connected) this.subagents.reset();
          this.adapter.sendCommand('work-plan-status');
          this.planPoll = setInterval(() => this.adapter.sendCommand('work-plan-status'), 4000);
          this.planPoll.unref?.();
        } else {
          this.refreshingPlan = false;
          this.lastPlanSummary = 'Unavailable · connection lost';
          this.status.setPlan(this.lastPlanSummary);
          this.clearStream(); this.activity.setThinking(null); this.activity.setTool(null);
        }
        this.connected = event.status === 'connected';
        this.status.setStatus(event.status); this.tui.requestRender();
        return false; // surfaces still handle reconnect/history
      case 'command.result':
        if (event.name === 'work-plan-status') {
          const summary = typeof event.result === 'string' ? event.result : '';
          const plan = event.error ? 'Unavailable' : summary || null;
          if (plan !== this.lastPlanSummary) {
            this.lastPlanSummary = plan; this.status.setPlan(plan);
            if (this.status.isPlanExpanded()) { this.refreshingPlan = true; this.adapter.sendCommand('work-plan'); }
            this.tui.requestRender();
          }
          return true;
        }
        if (event.name === 'work-plan' && event.error) this.refreshingPlan = false;
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
        // call, not the reply: keep it as its own message so the trail stays
        // visible, then start the next live block.
        if (event.iteration !== this.streamIteration) {
          if (this.streamText.trim()) this.pushMessage('assistant', this.streamText);
          this.streamText = '';
          this.streamIteration = event.iteration;
        }
        this.streamText += event.delta;
        this.messages.setLive(this.streamText);
        this.tui.requestRender();
        return true;
      case 'message':
        if (event.role === 'assistant') this.clearStream();
        this.pushMessage(event.role, event.content);
        return true;
      case 'agent.start':
        // A subagent gets its own row in the panel; the activity line stays
        // the ROOT agent's, so a fan-out doesn't make the main indicator
        // flicker between children.
        if (event.subagent && event.nodeId) {
          this.subagents.start(event.nodeId, event.role, event.model);
          this.tui.requestRender();
          return true;
        }
        // Start with iteration 0 so a long-running agent isn't silent
        // between spawn and its first iteration tick (the worker emits
        // iteration_update at the TOP of each loop iteration).
        this.activeAgentRole = event.role;
        this.activeAgentModel = event.model || undefined;
        this.clearStream(); // a new turn: whatever a failed one left half-streamed is not history
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
        this.streamToolEvent(event.tool);
        return true;
      case 'error':
        this.activity.setThinking(null); this.activity.setTool(null);
        this.clearStream();
        this.pushMessage('system', `Error: ${event.message}`);
        return true;
      case 'expert':
        this.status.setExpert(event.expertId);
        this.tui.requestRender();
        return true;
      default: return false;
    }
  }
  private clearStream(): void {
    this.streamText = '';
    this.streamIteration = -1;
    this.messages.setLive(null);
  }

  private streamToolEvent(tool: { state: string; name: string; preview?: string; mcpServer?: string }): void {
    const mcp = tool.mcpServer ? `[mcp:${tool.mcpServer}] ` : '';
    const preview = tool.preview ? ` → ${tool.preview}` : '';
    if (tool.state === 'pending' || tool.state === 'executing') {
      this.lastStreamedTool = `${tool.name}${preview}`;
      this.pushMessage('system', `→ ${mcp}${this.lastStreamedTool}`);
    } else if (tool.state === 'error') {
      this.pushMessage('system', `✗ ${mcp}${tool.name}${preview}`);
      this.lastStreamedTool = null;
    } else if (tool.state === 'completed') {
      // Only echo a completion line when there's an output preview worth
      // showing; the pending line already named the call.
      if (tool.preview) this.pushMessage('system', `✓ ${mcp}${tool.name} ${tool.preview}`);
      this.lastStreamedTool = null;
    }
  }

}
