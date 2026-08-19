import { Suspense } from 'react';
import TraceClient from './trace-client';

// Static route (`/runs/view?id=<sessionId>`) — same reason as
// `agents/view`: the export has no server to resolve a dynamic segment.
export default function Page() {
  return (
    <Suspense>
      <TraceClient />
    </Suspense>
  );
}
