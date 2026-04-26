'use client';

import { RotateCcw, Shield } from 'lucide-react';

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
   * Optional click handler. When set, stage rectangles render as buttons —
   * the consumer renders the matching list/code view side-by-side and
   * highlights the same index. Foundation for the two-view (graph ↔ code)
   * abstraction described in DESIGN.md.
   */
  onSelectStage?: (index: number) => void;
  /** Index of the currently-selected stage (renders an accent stroke). */
  selectedIndex?: number;
}

/**
 * Pure-SVG pipeline DAG view. Stages render top-to-bottom with arrows;
 * QA validation stages draw a curved retry arrow back to their target stage.
 *
 * Two-view abstraction (list ↔ graph) inspired by
 * https://github.com/WeaveMindAI/weft.
 */
export function PipelineGraph({ steps, onSelectStage, selectedIndex }: Props) {
  if (steps.length === 0) {
    return (
      <div className="text-sm text-on-surface-variant italic px-2 py-4">
        No stages yet — add stages to see the graph.
      </div>
    );
  }

  const BOX_W = 280;
  const BOX_H = 64;
  const GAP = 32;
  const PAD_X = 24;
  const RETRY_LANE_W = 80;
  const ROW_H = BOX_H + GAP;

  const totalH = steps.length * BOX_H + (steps.length - 1) * GAP + 16;
  const totalW = BOX_W + PAD_X * 2 + RETRY_LANE_W;

  return (
    <div className="overflow-x-auto">
      <svg
        width={totalW}
        height={totalH}
        viewBox={`0 0 ${totalW} ${totalH}`}
        className="text-white"
      >
        <defs>
          <marker
            id="arrow"
            markerWidth="10"
            markerHeight="10"
            refX="8"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L0,6 L9,3 z" fill="currentColor" className="text-on-surface-variant" />
          </marker>
          <marker
            id="arrow-retry"
            markerWidth="10"
            markerHeight="10"
            refX="8"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L0,6 L9,3 z" fill="currentColor" className="text-blue-400" />
          </marker>
        </defs>

        {steps.map((step, i) => {
          const y = i * ROW_H;
          const cx = PAD_X + BOX_W / 2;

          const arrowDown = i < steps.length - 1 ? (
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
          ) : null;

          // QA retry arrow — from this stage back to retryTargetStage.
          let retry = null;
          if (step.stageType === 'qa_validation' && typeof step.retryTargetStage === 'number') {
            const target = step.retryTargetStage;
            if (target >= 0 && target < i) {
              const startX = PAD_X + BOX_W;
              const startY = y + BOX_H / 2;
              const endY = target * ROW_H + BOX_H / 2;
              const laneX = PAD_X + BOX_W + 32;
              retry = (
                <g>
                  <path
                    d={`M ${startX} ${startY} L ${laneX} ${startY} L ${laneX} ${endY} L ${PAD_X + BOX_W + 4} ${endY}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray="6 3"
                    className="text-blue-400"
                    markerEnd="url(#arrow-retry)"
                  />
                  <text
                    x={laneX + 6}
                    y={(startY + endY) / 2}
                    fontSize="10"
                    className="fill-blue-400"
                  >
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
          const interactive = !!onSelectStage;

          return (
            <g
              key={i}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? `Stage ${i + 1}: ${step.name}` : undefined}
              aria-pressed={interactive ? isSelected : undefined}
              onClick={interactive ? () => onSelectStage(i) : undefined}
              onKeyDown={interactive ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectStage(i);
                }
              } : undefined}
              style={interactive ? { cursor: 'pointer', outline: 'none' } : undefined}
              className={interactive ? 'transition-opacity hover:opacity-90 focus:opacity-90' : undefined}
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
              <text
                x={PAD_X + 16}
                y={y + 24}
                fontSize="14"
                fontWeight="600"
                fill="#fff"
              >
                {`${i + 1}. ${step.name.slice(0, 24)}${step.name.length > 24 ? '…' : ''}`}
              </text>
              <text
                x={PAD_X + 16}
                y={y + 44}
                fontSize="11"
                fill="#9ca3af"
                fontFamily="monospace"
              >
                {step.topic}
              </text>
              {step.requiresApproval && (
                <foreignObject x={PAD_X + BOX_W - 32} y={y + 8} width="20" height="20">
                  <Shield className="w-4 h-4 text-orange-500" />
                </foreignObject>
              )}
              {step.stageType === 'qa_validation' && (
                <foreignObject x={PAD_X + BOX_W - 56} y={y + 8} width="20" height="20">
                  <RotateCcw className="w-4 h-4 text-blue-400" />
                </foreignObject>
              )}
              {arrowDown}
              {retry}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
