import type { ModuleDefinition } from '../core/modules/types';

export const voiceModule: ModuleDefinition = {
  id: 'voice',
  title: 'Voice and phone calls',
  description: 'Speech to text and text to speech in the chat and the mobile app, and phone calls through a telephony provider.',
  profiles: [],
  dependsOn: [],
  routes: ['/api/voice', '/voice'],
  pages: [],
  tools: ['voice'],
  jobs: [],
  caseEntities: [],
  docs: 'docs/VOICE.md',
};
