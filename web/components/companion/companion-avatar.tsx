'use client';

import { memo, useEffect, useRef, type CSSProperties } from 'react';
import { type CompanionAppearance, COMPANION_COLORS, DEFAULT_COMPANION_APPEARANCE, isCompanionAppearance } from '../../../src/shared/companion';
import './companion-avatar.css';

export type CompanionState = 'idle' | 'listening' | 'working' | 'waiting' | 'done' | 'interrupted';

const forms = {
  "pebble": {
    "arms": [
      [
        61.0,
        116.0,
        "M61 116 Q36 137 25 123"
      ],
      [
        70.0,
        124.0,
        "M70 124 Q49 158 38 142"
      ],
      [
        82.0,
        129.0,
        "M82 129 Q69 170 57 153"
      ],
      [
        94.0,
        132.0,
        "M94 132 Q88 176 79 163"
      ],
      [
        106.0,
        132.0,
        "M106 132 Q112 176 121 163"
      ],
      [
        118.0,
        129.0,
        "M118 129 Q131 170 143 153"
      ],
      [
        130.0,
        124.0,
        "M130 124 Q151 158 162 142"
      ],
      [
        139.0,
        116.0,
        "M139 116 Q164 137 175 123"
      ]
    ],
    "body": "M54 121 C45 96 49 57 76 45 C89 39 111 39 125 46 C151 58 155 97 146 121 C124 140 76 140 54 121Z",
    "left": 83.0,
    "right": 117.0,
    "y": 96.0,
    "rx": 10.0,
    "ry": 13.0
  },
  "ribbon": {
    "arms": [
      [
        70.0,
        116.0,
        "M70 116 C45 115 48 153 25 138"
      ],
      [
        77.0,
        123.0,
        "M77 123 C60 131 64 166 42 155"
      ],
      [
        86.0,
        129.0,
        "M86 129 C76 146 80 179 63 164"
      ],
      [
        96.0,
        132.0,
        "M96 132 Q96 181 83 170"
      ],
      [
        105.0,
        132.0,
        "M105 132 Q111 177 123 167"
      ],
      [
        115.0,
        128.0,
        "M115 128 C129 145 116 176 143 160"
      ],
      [
        124.0,
        123.0,
        "M124 123 C150 124 138 163 164 146"
      ],
      [
        132.0,
        116.0,
        "M132 116 C152 109 159 139 178 120"
      ]
    ],
    "body": "M66 119 C56 101 56 65 73 42 C88 22 114 25 128 46 C145 72 145 101 135 119 C115 136 85 136 66 119Z",
    "left": 85.0,
    "right": 115.0,
    "y": 92.0,
    "rx": 9.0,
    "ry": 12.0
  },
  "ink": {
    "arms": [
      [
        49.0,
        115.0,
        "M49 115 Q24 128 23 114"
      ],
      [
        60.0,
        124.0,
        "M60 124 Q36 148 29 133"
      ],
      [
        76.0,
        130.0,
        "M76 130 Q55 158 48 145"
      ],
      [
        91.0,
        133.0,
        "M91 133 Q78 166 70 151"
      ],
      [
        108.0,
        133.0,
        "M108 133 Q119 164 128 151"
      ],
      [
        124.0,
        130.0,
        "M124 130 Q145 158 152 142"
      ],
      [
        140.0,
        124.0,
        "M140 124 Q164 148 170 131"
      ],
      [
        151.0,
        115.0,
        "M151 115 Q176 128 178 113"
      ]
    ],
    "body": "M41 117 C35 94 48 62 75 54 C106 43 145 55 157 85 C163 99 162 112 156 123 C127 139 66 140 41 117Z",
    "left": 79.0,
    "right": 121.0,
    "y": 98.0,
    "rx": 12.0,
    "ry": 15.0
  }
} as const;

/** The saved octopus at conversation scale. History is still; only live activity opts into motion. */
export const CompanionAvatar = memo(function CompanionAvatar({
  state = 'idle', animated = false, size = 36, appearance, followPointer = false,
}: { state?: CompanionState; animated?: boolean; size?: number; appearance?: CompanionAppearance; followPointer?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!followPointer || !animated || state !== 'idle') return;
    const svg = svgRef.current;
    if (!svg) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    let frame = 0;
    let point = { x: 0, y: 0 };
    const reset = () => { delete svg.dataset.gaze; };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      point = { x: event.clientX, y: event.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (reduced.matches || !fine.matches || document.hidden) return reset();
        const bounds = svg.getBoundingClientRect();
        if (bounds.bottom < 0 || bounds.top > window.innerHeight) return reset();
        const dx = point.x - (bounds.left + bounds.width / 2);
        const dy = point.y - (bounds.top + bounds.height * .48);
        const distance = Math.hypot(dx, dy) || 1;
        const reach = Math.min(3.5, distance / 90);
        svg.style.setProperty('--gaze-x', `${dx / distance * reach}px`);
        svg.style.setProperty('--gaze-y', `${dy / distance * reach}px`);
        svg.dataset.gaze = 'pointer';
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('blur', reset);
    document.documentElement.addEventListener('pointerleave', reset);
    reduced.addEventListener('change', reset);
    fine.addEventListener('change', reset);
    return () => {
      cancelAnimationFrame(frame);
      reset();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('blur', reset);
      document.documentElement.removeEventListener('pointerleave', reset);
      reduced.removeEventListener('change', reset);
      fine.removeEventListener('change', reset);
    };
  }, [followPointer, animated, state]);
  const look = isCompanionAppearance(appearance) ? appearance : DEFAULT_COMPANION_APPEARANCE;
  const shape = forms[look.form];
  return (
    <svg
      ref={svgRef} viewBox="0 0 200 200" width={size} height={size} aria-hidden="true" focusable="false"
      className={`octi-companion${animated ? ' animated' : ''}`} data-state={state}
      style={{ color: COMPANION_COLORS[look.color].hex }} data-form={look.form} data-color={look.color}
      data-motion={animated ? 'on' : 'off'}
    >
      <ellipse className="resting-shadow" cx="100" cy="181" rx="49" ry="6" />
      <g className="pose">
        <g fill="none" stroke="currentColor" strokeWidth={look.form === 'ribbon' ? 12 : 15} strokeLinecap="round">
          {shape.arms.map(([x, y, d], i) => (
            <path key={d} d={d} className={`arm ${i === 0 ? 'arm-outer-left' : i === 7 ? 'arm-outer-right' : ''}`}
              style={{ transformOrigin: `${x}px ${y}px`, '--arm-index': i } as CSSProperties} />
          ))}
        </g>
        <path fill="currentColor" d={shape.body} />
        <path className="shine" fill="white" d="M65 76 Q67 56 86 52 Q73 62 72 77 Q68 83 65 76Z" />
        <g className="eyes">
          <ellipse cx={shape.left} cy={shape.y} rx={shape.rx} ry={shape.ry} fill="#f8fcf4" />
          <ellipse cx={shape.right} cy={shape.y} rx={shape.rx} ry={shape.ry} fill="#f8fcf4" />
          <g className="pupils" fill="#102c35">
            <ellipse cx={shape.left + 1} cy={shape.y + 1} rx="4.6" ry="6.2" />
            <ellipse cx={shape.right + 1} cy={shape.y + 1} rx="4.6" ry="6.2" />
          </g>
        </g>
        <path className="mouth" d={state === 'interrupted' ? `M95 ${shape.y + 21} H105` : `M95 ${shape.y + 19} Q100 ${shape.y + 23} 105 ${shape.y + 19}`} />
      </g>
    </svg>
  );
});
