import { Suspense } from 'react';
import DetailClient from './detail-client';

// Static route (`/eval/view?id=<runId>`). The detail used to be a dynamic
// `[id]` segment, which `output: 'export'` (Tauri) cannot pre-render for
// arbitrary runtime ids. A query param keeps a single static page that reads
// the id client-side via `useSearchParams`, which needs a Suspense boundary.
export default function Page() {
  return (
    <Suspense>
      <DetailClient />
    </Suspense>
  );
}
