/**
 * Size and rate limits for interactive answers. Constants, not admin config:
 * the browser enforces them too (docs/plans/inline-ui-spec.md §4.4).
 */
export const INLINE_UI_LIMITS = {
  titleChars: 80,
  htmlChars: 24_000,
  cssChars: 6_000,
  jsChars: 12_000,
  totalChars: 36_000,
  /** Blocks one reply may carry. */
  blocksPerReply: 4,
  /** Blocks a session may hold. */
  blocksPerSession: 200,
  defaultHeight: 320,
  minHeight: 40,
  maxHeight: 2_000,
  /** Height as a share of the viewport (S12: a frame never fills the screen). */
  maxHeightViewport: 0.8,
  /** Suggested-message text from a frame (P2). */
  promptChars: 1_000,
  /** Minimum gap between two `prompt`/`link` messages of one frame. */
  bridgeIntervalMs: 500,
  /** `error` messages one mount may send. */
  errorsPerMount: 20,
  /** Invalid or over-limit messages per second that unmount a frame. */
  floodPerSecond: 20,
  /** Client outcome reports one message may carry. */
  reportsPerMessage: 20,
  /** Live frames on a page (fewer on narrow screens). */
  mountedFrames: 6,
  mountedFramesNarrow: 3,
  /** Buttons the chat page draws next to a frame ignore input this long after appearing or moving (S6). */
  inputDelayMs: 800,
} as const;

export function clampInlineUiHeight(height: unknown, viewportHeight?: number): number {
  const n = typeof height === 'number' && Number.isFinite(height) ? Math.ceil(height) : INLINE_UI_LIMITS.defaultHeight;
  const viewportCap = viewportHeight && viewportHeight > 0
    ? Math.floor(viewportHeight * INLINE_UI_LIMITS.maxHeightViewport)
    : INLINE_UI_LIMITS.maxHeight;
  const max = Math.max(INLINE_UI_LIMITS.minHeight, Math.min(INLINE_UI_LIMITS.maxHeight, viewportCap));
  return Math.max(INLINE_UI_LIMITS.minHeight, Math.min(n, max));
}
