import { Suspense } from 'react';
import DetailClient from './detail-client';

// Static route (`/artifacts/view?id=<artifactId>`) — see eval/view/page.tsx
// for why this replaced the dynamic `[id]` segment.
export default function Page() {
  return (
    <Suspense>
      <DetailClient />
    </Suspense>
  );
}
