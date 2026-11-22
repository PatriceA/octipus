/**
 * Interactive answers on surfaces that cannot render them, read on the server
 * where the session is known (docs/plans/inline-ui-views-spec.md §5): a view
 * becomes its plain-markdown form, with the stored answer when there is one;
 * an HTML block, a block of another session, and any stray fence keep part
 * 1's one line (`inlineUiFallbackText`), as does a view whose text rendering
 * fails (logged), so a reply is never lost to it.
 */
import { inlineUiRepository } from '@/db/repositories/inline-ui-repository';
import { inlineUiFallbackText, inlineUiMarker, inlineUiMarkerIds, inlineUiViewText, replaceInlineUiMarkers, sanitizeInlineUiTitle } from '@/shared/inline-ui';
import { coreLogger } from '@/utils/logger';

/** The header line above a view written as text. */
export function inlineUiViewTextHeader(title: string): string {
  return `▸ Interactive answer “${sanitizeInlineUiTitle(title)}”:`;
}

export async function inlineUiFallbackTextResolved(text: string, sessionId: string | undefined): Promise<string> {
  const ids = sessionId ? inlineUiMarkerIds(text) : [];
  if (ids.length === 0 || !sessionId) return inlineUiFallbackText(text);
  const views = new Map((await inlineUiRepository.getManyInSession([...new Set(ids)], sessionId))
    .filter((b) => b.kind === 'view' && b.view)
    .map((b) => [b.id, b]));
  const resolved = replaceInlineUiMarkers(text, (marker) => {
    const block = views.get(marker.id);
    if (!block?.view) return inlineUiMarker(marker.id, marker.title);
    try {
      return `${inlineUiViewTextHeader(block.title)}\n\n${inlineUiViewText(block.view, block.state ? { data: block.state.data } : {})}`;
    } catch (err) {
      // A view that cannot be written as text costs its own block, never the reply: it keeps part 1's line.
      coreLogger.warn({ err, sessionId, blockId: block.id }, 'Interactive answer could not be written as text — kept as its one line');
      return inlineUiMarker(marker.id, marker.title);
    }
  });
  return inlineUiFallbackText(resolved);
}
