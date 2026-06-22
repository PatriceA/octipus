import { Suspense } from 'react';
import DetailClient from './detail-client';

// Static route (`/agents/view?id=<agentId>`) — see eval/view/page.tsx for why
// this replaced the dynamic `[id]` segment.
export default function Page() {
  return (
    <Suspense>
      <DetailClient />
    </Suspense>
  );
}
