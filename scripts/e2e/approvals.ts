/**
 * Approval polling for REST-driven runs.
 *
 * `POST /chat` blocks until the turn finishes — and a turn that raises an
 * approval blocks until a human answers or `approvalTimeoutMs` (1h) expires.
 * WebSocket clients get `orchestrator.approval_required` and can respond; a
 * plain REST caller is blind and the connection just looks hung.
 *
 * Rather than change that blocking contract (the web UI and TUI depend on
 * `POST /chat` returning the finished answer), a REST caller drives approvals
 * out-of-band on a second connection: poll `GET /chat/approvals/pending` and
 * answer via `POST /chat/approve` while the original request is still in
 * flight. That is the documented contract — see `src/api/routes/chat.ts`.
 *
 * docs/plans/blocked-vs-stuck.md Phase 2.
 */

import type { APIClient } from './client';

export interface PendingApproval {
  requestId: string;
  summary: string;
  question: string;
  options?: string[];
  createdAt?: string;
}

/** Fetch the caller's currently-pending approvals. */
export async function getPendingApprovals(client: APIClient, token?: string | null): Promise<PendingApproval[]> {
  const { status, data } = await client.request<{ approvals?: PendingApproval[] }>(
    'GET',
    '/chat/approvals/pending',
    undefined,
    token,
  );
  if (status !== 200) return [];
  return data.approvals ?? [];
}

/** Answer one approval. Returns true when the server accepted the resolution. */
export async function resolveApproval(
  client: APIClient,
  requestId: string,
  approved: boolean,
  response?: string,
  token?: string | null,
): Promise<boolean> {
  const { status, data } = await client.request<{ resolved?: boolean }>(
    'POST',
    '/chat/approve',
    { requestId, approved, response },
    token,
  );
  return status === 200 && data.resolved === true;
}

export interface AutoApproveHandle {
  /** Stop polling and resolve with everything answered so far. */
  stop: () => Promise<PendingApproval[]>;
  /** Approvals answered so far (live view). */
  readonly answered: PendingApproval[];
}

/**
 * Poll for pending approvals and answer them until stopped — so a REST-driven
 * pipeline run reaches completion without a human, and never looks like a hang.
 *
 * Start this BEFORE the `POST /chat` call you expect to block; it runs on its
 * own connection while that request is outstanding. `stop()` is idempotent.
 *
 * `answer` decides per approval; default approves. Returning a string picks
 * that option (the pipeline offers 'Approve' / 'Skip' / 'Stop Pipeline').
 */
export function autoApproveLoop(
  client: APIClient,
  opts: {
    intervalMs?: number;
    token?: string | null;
    answer?: (a: PendingApproval) => boolean | string;
    onApproval?: (a: PendingApproval) => void;
  } = {},
): AutoApproveHandle {
  const intervalMs = opts.intervalMs ?? 1000;
  const answered: PendingApproval[] = [];
  const seen = new Set<string>();
  let stopped = false;

  const loop = (async () => {
    while (!stopped) {
      try {
        for (const approval of await getPendingApprovals(client, opts.token)) {
          // A requestId can reappear in the list until the server has fully
          // resolved it; answering twice is harmless but pointless.
          if (seen.has(approval.requestId)) continue;
          seen.add(approval.requestId);
          const verdict = opts.answer ? opts.answer(approval) : true;
          const ok = await resolveApproval(
            client,
            approval.requestId,
            verdict !== false,
            typeof verdict === 'string' ? verdict : undefined,
            opts.token,
          );
          if (ok) {
            answered.push(approval);
            opts.onApproval?.(approval);
          } else {
            // Someone else answered it, or it timed out — let it be retried.
            seen.delete(approval.requestId);
          }
        }
      } catch {
        // A polling blip must never fail the run it is only assisting.
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();

  return {
    answered,
    stop: async () => {
      stopped = true;
      await loop;
      return answered;
    },
  };
}
