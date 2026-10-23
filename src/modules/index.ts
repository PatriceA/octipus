/**
 * Every module (docs/MODULES.md). Adding one is a file next to this one and a
 * line here; `registry.test.ts` checks that every route, tool and job it
 * names belongs to it alone.
 */
import type { ModuleDefinition } from '../core/modules/types';
import { businessModule } from './business';
import { mailModule } from './mail';
import { protectionModule } from './protection';
import { scanFoldersModule } from './scan-folders';

export const MODULES: readonly ModuleDefinition[] = [
  businessModule,
  mailModule,
  scanFoldersModule,
  protectionModule,
];
