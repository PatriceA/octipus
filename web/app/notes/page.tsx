import { Suspense } from 'react';
import { NotesWorkspace } from './notes-workspace';

// The notes workspace reads `?view=` from the URL (useSearchParams), so it must
// sit under a Suspense boundary in the app router.
export default function NotesPage() {
  return (
    <Suspense fallback={null}>
      <NotesWorkspace />
    </Suspense>
  );
}
