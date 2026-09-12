/** Never replace an unanswered agent question with a newer one. */
import type { OverlayHandle } from '@mariozechner/pi-tui';
import type { AgentSessionEvent, GatewayAdapter } from './gateway-adapter';
import type { OverlayController } from './overlays/registry';
type Decision = Extract<AgentSessionEvent, { kind: 'permission' | 'approval' }>;
export class DecisionQueue {
  private pending: Decision[] = [];
  private handle: OverlayHandle | null = null;
  private disposed = false;
  constructor(private readonly overlays: OverlayController, private readonly adapter: GatewayAdapter,
    private readonly report: (text: string) => void, private readonly restoreFocus: () => void) {}
  push(event: Decision): void {
    if (this.disposed || this.pending.some(item => item.requestId === event.requestId)) return;
    this.pending.push(event);
    if (!this.handle) this.show();
  }
  private show(): void {
    const event = this.pending[0];
    if (!event) return;
    const respond = (approved: boolean, response: string) => {
      // A late overlay callback (after dispose, or after this event was
      // already answered) must not send a second, conflicting decision.
      if (this.disposed || this.pending[0] !== event) return;
      this.answer(event, approved, response);
      this.report(event.kind === 'permission'
        ? `${approved ? 'Approved' : 'Denied'}: ${response}`
        : `${approved ? 'Answered' : 'Declined'}: ${response}`);
      this.handle?.hide(); this.handle = null; this.pending.shift();
      if (this.pending.length) this.show(); else this.restoreFocus();
    };
    try {
      this.handle = event.kind === 'approval'
        ? this.overlays.showApprovalPrompt({ ...event, onRespond: respond })
        : this.overlays.showPermissionPrompt({ ...event,
          onApprove: () => respond(true, event.toolName), onDeny: () => respond(false, event.toolName), onCancel: () => respond(false, event.toolName) });
    } catch (err) {
      // An overlay that cannot be shown must not wedge every later decision:
      // decline this one (the agent is blocked on it) and move on.
      this.handle = null; this.pending.shift();
      this.answer(event, false, 'Prompt could not be shown');
      this.report(`Error: could not show the ${event.kind} prompt (${(err as Error).message}); declined.`);
      if (this.pending.length) this.show();
    }
  }
  private answer(event: Decision, approved: boolean, response: string): void {
    if (event.kind === 'permission') this.adapter.respondPermission(event.requestId, approved);
    else this.adapter.respondApproval(event.requestId, approved, response);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.handle?.hide(); this.handle = null;
    for (const event of this.pending) this.answer(event, false, 'Client closed');
    this.pending = [];
  }
}
