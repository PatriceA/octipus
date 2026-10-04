'use client';

import { RefreshCw, TriangleAlert } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { useAuth } from './auth-context';
import { gateway, type GatewayMessage, type GatewayStatus, type WebGateway } from './gateway';

const GatewayContext = createContext<WebGateway>(gateway);

/**
 * Opens the tab's gateway connection while the user is signed in and shares
 * it with every consumer (`useGateway`, `useGatewayMessages`). Shows "Too
 * many open tabs" when the account is at its connection cap.
 */
export function GatewayProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;
    gateway.start();
    return () => gateway.stop();
  }, [isAuthenticated]);

  return (
    <GatewayContext.Provider value={gateway}>
      {children}
      <TooManyTabsBanner />
    </GatewayContext.Provider>
  );
}

/** The shared connection. */
export function useGateway(): WebGateway {
  return useContext(GatewayContext);
}

/** The connection's status, re-rendering on change. */
export function useGatewayStatus(): GatewayStatus {
  const client = useGateway();
  return useSyncExternalStore(
    (onChange) => client.onStatus(onChange),
    () => client.getStatus(),
    () => 'idle' as GatewayStatus,
  );
}

/**
 * Call `handler` with every server message. The latest `handler` is used
 * without resubscribing, so it may close over render state.
 */
export function useGatewayMessages(handler: (message: GatewayMessage) => void): void {
  const client = useGateway();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => client.onMessage((message) => latest.current(message)), [client]);
}

function TooManyTabsBanner() {
  const client = useGateway();
  const status = useGatewayStatus();
  if (status !== 'too_many_tabs') return null;
  return (
    <div role="alert" data-testid="too-many-tabs" className="fixed top-0 left-0 right-0 z-[60] flex items-center justify-center gap-3 border-b border-error/50 bg-error-container px-4 py-2 font-mono text-sm text-on-error-container">
      <TriangleAlert className="h-4 w-4 shrink-0" />
      <span>Too many open tabs — this tab gets no live updates. Close another Octipus tab, then retry.</span>
      <button
        type="button"
        onClick={() => client.retry()}
        className="inline-flex items-center gap-1 rounded-xs border border-current px-2 py-0.5 text-xs cursor-pointer hover:bg-error/10"
      >
        <RefreshCw className="h-3 w-3" /> Retry
      </button>
    </div>
  );
}
