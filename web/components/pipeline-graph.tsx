'use client';

import { GripVertical, Plus, RotateCcw, Shield, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';

interface Step {
  name: string;
  topic: string;
  requiresApproval?: boolean;
  stageType?: string;
  retryTargetStage?: number;
  maxRetries?: number;
}

interface Props {
  steps: Step[];
  /**
   * Click handler. When set, stage rectangles render as buttons — the
   * consumer renders the matching list/code view side-by-side and
   * highlights the same index. Foundation for the two-view (graph ↔ code)
   * abstraction described in DESIGN.md.
   */
  onSelectStage?: (index: number) => void;
  /** Index of the currently-selected stage (renders an accent stroke). */
  selectedIndex?: number;
  /**
   * Edit mode — when true, renders inline `+` insertion buttons between
   * stages and a delete `×` button on each stage. The graph and the
   * sibling list view share a single `steps` state in the consumer, so
   * either surface can mutate the pipeline and the other re-renders.
   */
  editable?: boolean;
  /** Called when the user removes a stage from the graph. */
  onDeleteStage?: (index: number) => void;
  /**
   * Called when the user inserts a stage after the given index. Pass
   * `-1` for "insert at the top" (rendered as a `+` above stage 0).
   */
  onInsertAfter?: (index: number) => void;
  /**
   * Called when the user drags a stage to a new position. The graph
   * renders a drag handle on each stage card when this is set; the
   * consumer is expected to apply the move via `reorderStages()` so QA
   * `retryTargetStage` indices stay aligned.
   */
  onReorder?: (from: number, to: number) => void;
}

/**
 * Pure-SVG pipeline DAG view. Stages render top-to-bottom with arrows;
 * QA validation stages draw a curved retry arrow back to their target stage.
 *
 * In editable mode (`editable`), the graph is a first-class edit surface:
 * delete a stage, insert between stages, or click to focus it in the
 * sibling list editor.
 */
export function PipelineGraph({
  steps,
  onSelectStage,
  selectedIndex,
  editable,
  onDeleteStage,
  onInsertAfter,
  onReorder,
}: Props) {
  const interactive = !!onSelectStage;
  const draggable = !!(editable && onReorder);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // While dragging: { from, targetIdx } in array indices.
  const [drag, setDrag] = useState<{ from: number; targetIdx: number } | null>(null);

  const BOX_W = 280;
  const BOX_H = 64;
  const GAP = 32;
  const PAD_X = 24;
  const PAD_Y = editable ? 24 : 8; // top breathing room for the leading insertion button
  const RETRY_LANE_W = 80;
  const ROW_H = BOX_H + GAP;

  const totalH = steps.length * ROW_H - GAP + PAD_Y * 2;
  const totalW = BOX_W + PAD_X * 2 + RETRY_LANE_W;

  const cx = PAD_X + BOX_W / 2;

  // Convert a client (screen) Y coordinate into the SVG's local Y space.
  const clientYToSvgY = (clientY: number): number => {
    const svg = svgRef.current;
    if (!svg) return clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return clientY;
    const pt = svg.createSVGPoint();
    pt.x = 0;
    pt.y = clientY;
    const local = pt.matrixTransform(ctm.inverse());
    return local.y;
  };

  // Map an SVG Y coord to the stage index whose center it is closest to.
  const svgYToTargetIdx = (svgY: number): number => {
    const raw = Math.round((svgY - PAD_Y - BOX_H / 2) / ROW_H);
    if (raw < 0) return 0;
    if (raw > steps.length - 1) return steps.length - 1;
    return raw;
  };

  // Pointer-drag wiring. `pointermove`/`pointerup` listen on `window` so a
  // drag that exits the SVG bounds still resolves cleanly.
  //
  // IMPORTANT: this useEffect MUST run on every render of this component,
  // including the empty-state branch below. Putting it after the early
  // return would call hooks conditionally and trigger React error #300
  // ("rendered fewer/more hooks than the previous render") any time
  // the user adds the first stage or deletes the last one.
  useEffect(() => {
    if (!drag || !onReorder) return;
    const onMove = (e: PointerEvent) => {
      const y = clientYToSvgY(e.clientY);
      const idx = svgYToTargetIdx(y);
      setDrag(d => (d && d.targetIdx !== idx ? { ...d, targetIdx: idx } : d));
    };
    const onUp = () => {
      setDrag(d => {
        if (d && d.from !== d.targetIdx) onReorder(d.from, d.targetIdx);
        return null;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // The handlers close over `drag.from`; re-binding on every drag start is
    // cheap and avoids a ref dance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.from, onReorder, steps.length]);

  // Empty state — must come AFTER all hooks so render-count stays stable.
  if (steps.length === 0) {
    if (editable && onInsertAfter) {
      return (
        <div className="flex items-center justify-center py-8">
          <button
            type="button"
            onClick={() => onInsertAfter(-1)}
            className="flex items-center gap-2 px-4 py-2 rounded-full text-sm bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Add first stage
          </button>
        </div>
      );
    }
    return (
      <div className="text-sm text-on-surface-variant italic px-2 py-4">
        No stages yet — add stages to see the graph.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <svg
        ref={svgRef}
        width={totalW}
        height={totalH}
        viewBox={`0 0 ${totalW} ${totalH}`}
        className="text-on-surface"
      >
        <defs>
          <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L0,6 L9,3 z" fill="currentColor" className="text-on-surface-variant" />
          </marker>
          <marker id="arrow-retry" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L0,6 L9,3 z" fill="currentColor" className="text-primary" />
          </marker>
        </defs>

        {/* Leading insertion button (insert at top, before stage 0) */}
        {editable && onInsertAfter && (
          <foreignObject x={cx - 12} y={PAD_Y - 22} width="24" height="20">
            <button
              type="button"
              aria-label="Insert stage at the top"
              onClick={() => onInsertAfter(-1)}
              className="w-6 h-6 rounded-full bg-primary/15 text-primary hover:bg-primary/30 cursor-pointer flex items-center justify-center"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </foreignObject>
        )}

        {steps.map((step, i) => {
          const y = PAD_Y + i * ROW_H;

          // Down arrow OR insertion button between stages
          let between: JSX.Element | null = null;
          if (i < steps.length - 1) {
            if (editable && onInsertAfter) {
              between = (
                <g>
                  <line
                    x1={cx}
                    y1={y + BOX_H}
                    x2={cx}
                    y2={y + BOX_H + GAP}
                    stroke="currentColor"
                    strokeWidth="2"
                    className="text-on-surface-variant"
                    markerEnd="url(#arrow)"
                  />
                  <foreignObject x={cx - 12} y={y + BOX_H + GAP / 2 - 10} width="24" height="20">
                    <button
                      type="button"
                      aria-label={`Insert stage after stage ${i + 1}`}
                      onClick={() => onInsertAfter(i)}
                      className="w-6 h-6 rounded-full bg-primary/15 text-primary hover:bg-primary/30 cursor-pointer flex items-center justify-center"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </foreignObject>
                </g>
              );
            } else {
              between = (
                <line
                  x1={cx}
                  y1={y + BOX_H}
                  x2={cx}
                  y2={y + BOX_H + GAP}
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-on-surface-variant"
                  markerEnd="url(#arrow)"
                />
              );
            }
          }

          // QA retry arrow — from this stage back to retryTargetStage.
          let retry: JSX.Element | null = null;
          if (step.stageType === 'qa_validation' && typeof step.retryTargetStage === 'number') {
            const target = step.retryTargetStage;
            if (target >= 0 && target < i) {
              const startX = PAD_X + BOX_W;
              const startY = y + BOX_H / 2;
              const endY = PAD_Y + target * ROW_H + BOX_H / 2;
              const laneX = PAD_X + BOX_W + 32;
              retry = (
                <g>
                  <path
                    d={`M ${startX} ${startY} L ${laneX} ${startY} L ${laneX} ${endY} L ${PAD_X + BOX_W + 4} ${endY}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray="6 3"
                    className="text-primary"
                    markerEnd="url(#arrow-retry)"
                  />
                  <text x={laneX + 6} y={(startY + endY) / 2} fontSize="10" className="fill-blue-400">
                    retry × {step.maxRetries ?? 3}
                  </text>
                </g>
              );
            }
          }

          const fill = step.stageType === 'qa_validation' ? '#1e3a5f' : '#1f2937';
          const isSelected = i === selectedIndex;
          const stroke = isSelected ? '#73ffe3' : step.requiresApproval ? '#f97316' : '#374151';
          const strokeWidth = isSelected ? 2.5 : step.requiresApproval ? 2 : 1;

          const isDraggingThis = drag?.from === i;
          return (
            <g
              key={i}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? `Stage ${i + 1}: ${step.name || 'Untitled'}` : undefined}
              aria-pressed={interactive ? isSelected : undefined}
              onClick={interactive && !drag ? () => onSelectStage(i) : undefined}
              onKeyDown={
                interactive
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectStage(i);
                      }
                    }
                  : undefined
              }
              style={interactive ? { cursor: 'pointer', outline: 'none' } : undefined}
              className={interactive ? 'transition-opacity hover:opacity-90 focus:opacity-90' : undefined}
              opacity={isDraggingThis ? 0.4 : 1}
            >
              <rect
                x={PAD_X}
                y={y}
                width={BOX_W}
                height={BOX_H}
                rx="12"
                fill={fill}
                stroke={stroke}
                strokeWidth={strokeWidth}
              />
              <text x={PAD_X + (draggable ? 36 : 16)} y={y + 24} fontSize="14" fontWeight="600" fill="#fff">
                {`${i + 1}. ${(step.name || 'Untitled').slice(0, 24)}${(step.name || '').length > 24 ? '…' : ''}`}
              </text>
              <text x={PAD_X + (draggable ? 36 : 16)} y={y + 44} fontSize="11" fill="#9ca3af" fontFamily="monospace">
                {step.topic}
              </text>
              {step.requiresApproval && (
                <foreignObject x={PAD_X + BOX_W - 32} y={y + 8} width="20" height="20">
                  <Shield className="w-4 h-4 text-warning" />
                </foreignObject>
              )}
              {step.stageType === 'qa_validation' && (
                <foreignObject x={PAD_X + BOX_W - 56} y={y + 8} width="20" height="20">
                  <RotateCcw className="w-4 h-4 text-primary" />
                </foreignObject>
              )}
              {/* Drag handle (edit + reorder mode) — leading edge of the card */}
              {draggable && (
                <foreignObject x={PAD_X + 4} y={y + BOX_H / 2 - 12} width="24" height="24">
                  <button
                    type="button"
                    aria-label={`Drag stage ${i + 1} to reorder`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      // Capture so subsequent moves from this pointer fire.
                      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
                      setDrag({ from: i, targetIdx: i });
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-6 h-6 rounded text-on-surface-variant hover:bg-on-surface/10 cursor-grab active:cursor-grabbing flex items-center justify-center touch-none"
                  >
                    <GripVertical className="w-4 h-4" />
                  </button>
                </foreignObject>
              )}
              {/* Delete button (edit mode) — sits in the trailing corner */}
              {editable && onDeleteStage && (
                <foreignObject x={PAD_X + BOX_W - 28} y={y + BOX_H - 28} width="24" height="24">
                  <button
                    type="button"
                    aria-label={`Delete stage ${i + 1}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteStage(i);
                    }}
                    className="w-6 h-6 rounded-full bg-error/15 text-error hover:bg-error/30 cursor-pointer flex items-center justify-center"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </foreignObject>
              )}
              {between}
              {retry}
            </g>
          );
        })}

        {/* Drop indicator while dragging — horizontal accent at the target row's center */}
        {drag && drag.from !== drag.targetIdx && (
          <line
            x1={PAD_X - 4}
            x2={PAD_X + BOX_W + 4}
            y1={PAD_Y + drag.targetIdx * ROW_H + BOX_H / 2}
            y2={PAD_Y + drag.targetIdx * ROW_H + BOX_H / 2}
            stroke="#73ffe3"
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.9"
          />
        )}

        {/* Trailing insertion button (insert after last stage) */}
        {editable && onInsertAfter && steps.length > 0 && (
          <foreignObject
            x={cx - 12}
            y={PAD_Y + steps.length * ROW_H - GAP + 6}
            width="24"
            height="20"
          >
            <button
              type="button"
              aria-label="Append stage at the end"
              onClick={() => onInsertAfter(steps.length - 1)}
              className="w-6 h-6 rounded-full bg-primary/15 text-primary hover:bg-primary/30 cursor-pointer flex items-center justify-center"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </foreignObject>
        )}
      </svg>
    </div>
  );
}

// Re-export the validator from the shared (bun-test-covered) location.
// `@/*` in this Next.js app resolves to `./web/*`, so we use a relative
// path to reach `src/core/orchestrator/pipeline-validation.ts`.
export { validatePipelineStages } from '../../src/core/orchestrator/pipeline-validation';
