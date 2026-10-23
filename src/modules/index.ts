/**
 * Every module (docs/MODULES.md). Adding one is a file next to this one and a
 * line here; `registry.test.ts` checks that every route, tool and job it
 * names belongs to it alone.
 */
import type { ModuleDefinition } from '../core/modules/types';
import { artifactsModule } from './artifacts';
import { businessModule } from './business';
import { channelsModule } from './channels';
import { inboxModule } from './inbox';
import { mailModule } from './mail';
import { peopleModule } from './people';
import { protectionModule } from './protection';
import { readerModule } from './reader';
import { recallModule } from './recall';
import { researchModule } from './research';
import { scanFoldersModule } from './scan-folders';
import { voiceModule } from './voice';

export const MODULES: readonly ModuleDefinition[] = [
  businessModule,
  mailModule,
  scanFoldersModule,
  protectionModule,
  researchModule,
  readerModule,
  recallModule,
  inboxModule,
  artifactsModule,
  peopleModule,
  voiceModule,
  channelsModule,
];
