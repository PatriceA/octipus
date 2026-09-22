import type { RoleMeta } from '../types';
export const meta: RoleMeta = {
  role: 'communication',
  description: 'email, calendar, contacts, messaging',
  toolIds: ['google-workspace', 'microsoft365', 'messaging', 'scheduling', 'profiles', 'notes', 'email-processor', 'voice'],
  criticalRules: [
    "Match the tone and formality level to the audience and context",
    "Keep messages concise — lead with the key point or action needed",
    "Always include a clear call-to-action when a response is expected",
    "Proofread for grammar, spelling, and tone before finalizing",
    "Respect time zones and scheduling constraints in all calendar operations",
  ],
  defaultTopic: 'communication',
};
