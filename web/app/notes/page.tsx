import { Suspense } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { NotesWorkspace } from './notes-workspace';
import { RemoteNotesWorkspace } from './remote-notes';

// The notes workspace reads `?view=` from the URL (useSearchParams), so it must
// sit under a Suspense boundary in the app router.
export default function NotesPage() {
  // A space on another install: its notes through the remote source (federation §8.3).
  const { activeWorkspace } = useWorkspace();
  if (activeWorkspace?.kind === 'remote') return <RemoteNotesWorkspace key={activeWorkspace.id} remote={activeWorkspace} />;
  return (
    <Suspense fallback={null}>
      <NotesWorkspace />
    </Suspense>
  );
}
