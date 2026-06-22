import { Suspense } from 'react';
import DetailClient from './detail-client';

// Static route (`/admin/orgs/sso?id=<orgId>`) — see eval/view/page.tsx for why
// this replaced the dynamic `[id]/sso` segment.
export default function Page() {
  return (
    <Suspense>
      <DetailClient />
    </Suspense>
  );
}
