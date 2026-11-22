/**
 * Whether a value is a stored view as this install would have stored it
 * (docs/plans/inline-ui-views-spec.md §2.3): written back to its authored
 * form, it lints without a fatal issue and normalizes to exactly itself. For
 * views that come from elsewhere — another install's answer to `room.inline_ui`
 * — before a browser renders them.
 */
import { type InlineUiView, isJsonObject, isJsonValue, jsonEqual, type JsonValue, lintInlineUiView, viewToAuthored } from '@/shared/inline-ui';

/** What is wrong with `value` as a stored view, or null. */
export function storedViewProblem(value: unknown): string | null {
  if (!isJsonObject(value) || !isJsonValue(value)) return 'the view is not a JSON object';
  let body: string;
  try {
    body = JSON.stringify(viewToAuthored(value as unknown as InlineUiView));
  } catch (err) {
    // viewToAuthored walks the component list; a malformed one throws.
    return `the view is not a stored view: ${(err as Error).message}`;
  }
  const { view, issues } = lintInlineUiView(body, { closed: true });
  if (!view) return issues.find((i) => i.severity === 'fatal')?.message ?? 'the view does not validate';
  return jsonEqual(view as unknown as JsonValue, value) ? null : 'the view is not in its normalized form';
}
