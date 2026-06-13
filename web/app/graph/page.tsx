import { redirect } from 'next/navigation';

// The knowledge graph now lives inside the notes workspace as a view mode
// (notes and the graph are the same thing). This route redirects there so any
// existing links / bookmarks keep working.
export default function GraphPage() {
  redirect('/notes?view=graph');
}
