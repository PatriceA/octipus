'use client';

import { Navigate } from 'react-router-dom';

// The knowledge graph now lives inside the notes workspace as a view mode
// (notes and the graph are the same thing). This route redirects there so any
// existing links / bookmarks keep working.
//
// `replace` so the bookmark does not sit in history between the user and the
// back button.
export default function GraphPage() {
  return <Navigate to="/notes?view=graph" replace />;
}
