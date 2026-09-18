import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'finance',
  toolIds: ['browser', 'websearch', 'filesystem'],
  criticalRules: [
    "Always disclose assumptions underlying financial projections",
    "Include risk factors and sensitivity analysis for all forecasts",
    "Use auditable, traceable calculations — never black-box numbers",
    "Clearly distinguish between historical data and forward-looking estimates",
    "Never present financial analysis as investment advice",
  ],
  defaultTopic: 'finance',
};
