import { COMPANION_COLORS, type CompanionAppearance, type CompanionState, DEFAULT_COMPANION_APPEARANCE, isCompanionAppearance } from './companion';
import { COMPANION_FORM_SHAPES } from './companion-forms';

/**
 * Small-icon animation of the companion: the browser tab icon and the desktop
 * tray icon. Those surfaces take a few still images, not CSS keyframes, so
 * each state is a short list of poses drawn as standalone SVG documents. The
 * caller rasterises them (a canvas in the web app) and flips through them
 * every `intervalMs`; a non-looping animation stays on its last frame.
 */
export interface CompanionFrames {
  frames: string[];
  intervalMs: number;
  loop: boolean;
}

interface Pose {
  /** Body lift in view-box units (negative is up). */
  dy?: number;
  /** Whole-body tilt in degrees. */
  tilt?: number;
  /** Horizontal squash/stretch of the body. */
  squash?: number;
  /** Alternating sway of the six inner arms, in degrees. */
  sway?: number;
  /** Outer arms raised (positive lifts both). */
  reach?: number;
  eyes?: 'open' | 'closed' | 'squint';
  look?: [number, number];
  mouth?: 'smile' | 'flat' | 'open';
  /** Small glyph beside the head. */
  mark?: 'alert' | 'alert-dim' | 'spark' | 'z' | 'zz';
  dim?: boolean;
}

const ALERT = '#f2b34a';
const INK = '#102c35';

/** The poses each state cycles through. Kept tiny: the icon is 16–32 px. */
const ANIMATIONS: Record<CompanionState, { poses: Pose[]; intervalMs: number; loop: boolean }> = {
  // Mostly still with a blink every few seconds.
  idle: { poses: [{}, {}, {}, {}, {}, { eyes: 'closed' }], intervalMs: 600, loop: true },
  listening: { poses: [{ reach: 18, look: [1, -3] }, { reach: 22, dy: -2, look: [1, -3] }, { reach: 18, look: [1, -3] }, { reach: 18, eyes: 'closed' }], intervalMs: 600, loop: true },
  working: {
    poses: [
      { sway: 14, dy: 0, look: [-3, 2] },
      { sway: -14, dy: -5, look: [0, 2] },
      { sway: 14, dy: -2, look: [3, 2] },
      { sway: -14, dy: -6, look: [0, 2] },
    ],
    intervalMs: 200,
    loop: true,
  },
  waiting: {
    poses: [
      { tilt: -10, reach: 34, look: [-2, -3], mark: 'alert' },
      { tilt: -12, reach: 48, dy: -3, look: [-2, -3], mark: 'alert-dim' },
    ],
    intervalMs: 650,
    loop: true,
  },
  done: {
    poses: [
      { squash: 1.08, dy: 1 },
      { dy: -14, reach: 60, mouth: 'open' },
      { dy: -6, reach: 50, tilt: 6, mouth: 'open', mark: 'spark' },
      { reach: 20, mark: 'spark' },
    ],
    intervalMs: 170,
    loop: false,
  },
  interrupted: { poses: [{ dy: 6, tilt: 4, eyes: 'squint', look: [0, 3], mouth: 'flat', reach: -18, dim: true }], intervalMs: 1000, loop: false },
  sleeping: {
    poses: [
      { eyes: 'closed', dy: 3, squash: 1.02, mark: 'z' },
      { eyes: 'closed', dy: 1, mark: 'zz' },
    ],
    intervalMs: 1400,
    loop: true,
  },
};

function f(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function markSvg(mark: Pose['mark'], color: string): string {
  switch (mark) {
    case 'alert':
    case 'alert-dim':
      return `<circle cx="158" cy="42" r="${mark === 'alert' ? 32 : 28}" fill="${ALERT}" stroke="${INK}" stroke-width="7"/>`
        + `<path d="M158 25 V47" stroke="${INK}" stroke-width="11" stroke-linecap="round"/><circle cx="158" cy="60" r="6.5" fill="${INK}"/>`;
    case 'spark':
      return `<path d="M166 22 L172 38 L188 44 L172 50 L166 66 L160 50 L144 44 L160 38Z" fill="${ALERT}"/>`;
    case 'z':
      return `<path d="M150 34 H170 L150 56 H170" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'zz':
      return `<path d="M146 44 H162 L146 62 H162" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`
        + `<path d="M168 14 H184 L168 32 H184" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
    default:
      return '';
  }
}

/** One pose of one form as a complete SVG document. */
function poseSvg(look: CompanionAppearance, pose: Pose): string {
  const shape = COMPANION_FORM_SHAPES[look.form];
  const color = COMPANION_COLORS[look.color].hex;
  const { dy = 0, tilt = 0, squash = 1, sway = 0, reach = 0, eyes = 'open', mouth = 'smile' } = pose;
  const [lx, ly] = pose.look ?? [0, 0];
  const width = look.form === 'ribbon' ? 13 : 16;
  const arms = shape.arms.map(([x, y, d], i) => {
    // Outer arms lift away from the body; the inner six sway in alternation.
    const angle = i === 0 ? reach : i === 7 ? -reach : (i % 2 === 0 ? sway : -sway);
    return `<path d="${d}" transform="rotate(${f(angle)} ${x} ${y})"/>`;
  }).join('');
  const eye = (cx: number) => {
    if (eyes === 'closed') return `<path d="M${f(cx - shape.rx)} ${f(shape.y + 2)} Q${cx} ${f(shape.y + 8)} ${f(cx + shape.rx)} ${f(shape.y + 2)}" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`;
    const ry = eyes === 'squint' ? shape.ry * .7 : shape.ry;
    return `<ellipse cx="${cx}" cy="${shape.y}" rx="${shape.rx}" ry="${f(ry)}" fill="#f8fcf4"/>`
      + `<ellipse cx="${f(cx + 1 + lx)}" cy="${f(shape.y + 1 + ly)}" rx="5.2" ry="${eyes === 'squint' ? 4.4 : 6.6}" fill="${INK}"/>`;
  };
  const mouthPath = mouth === 'flat'
    ? `<path d="M94 ${shape.y + 21} H106" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`
    : mouth === 'open'
      ? `<ellipse cx="100" cy="${shape.y + 21}" rx="5" ry="4" fill="${INK}"/>`
      : `<path d="M94 ${shape.y + 19} Q100 ${shape.y + 24} 106 ${shape.y + 19}" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`;
  const transform = `translate(0 ${f(dy)}) rotate(${f(tilt)} 100 125) translate(100 125) scale(${f(squash)} ${f(2 - squash)}) translate(-100 -125)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 8 180 180" width="64" height="64">`
    + `<g${pose.dim ? ' opacity=".6"' : ''}>`
    + `<g transform="${transform}">`
    + `<g fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round">${arms}</g>`
    + `<path d="${shape.body}" fill="${color}"/>`
    + eye(shape.left) + eye(shape.right) + mouthPath
    + `</g></g>${markSvg(pose.mark, color)}</svg>`;
}

/** The icon animation for a state, drawn in the user's saved appearance. */
export function companionFrames(appearance: CompanionAppearance | undefined, state: CompanionState): CompanionFrames {
  const look = isCompanionAppearance(appearance) ? appearance : DEFAULT_COMPANION_APPEARANCE;
  const animation = ANIMATIONS[state];
  return {
    frames: animation.poses.map(pose => poseSvg(look, pose)),
    intervalMs: animation.intervalMs,
    loop: animation.loop,
  };
}
