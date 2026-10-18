'use client';

import { memo, useEffect, useRef, type CSSProperties } from 'react';
import { type CompanionAppearance, type CompanionState, COMPANION_COLORS, DEFAULT_COMPANION_APPEARANCE, isCompanionAppearance } from '../../../src/shared/companion';
import { COMPANION_FORM_SHAPES as forms } from '../../../src/shared/companion-forms';
import './companion-avatar.css';

export type { CompanionState };

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
      {state === 'sleeping' && (
        <g className="octi-dream" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M150 40 H164 L150 56 H164" />
          <path className="later" d="M170 16 H180 L170 28 H180" />
        </g>
      )}
    </svg>
  );
});
