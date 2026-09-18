import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'design',
  description: 'UI/UX, layout, accessibility',
  toolIds: ['browser', 'filesystem'],
  criticalRules: [
    "Always consider accessibility (WCAG 2.1 AA minimum) in every design decision",
    "Design mobile-first, then scale up to larger viewports",
    "Maintain consistent spacing, typography, and color usage across components",
    "Ensure all interactive elements have visible focus states and hover feedback",
    "Never sacrifice usability for aesthetics",
  ],
  defaultTopic: 'design',
};
