import { pgTable, text, uuid, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import type { ConformanceResult } from '@/models/testing/conformance';
import type { EvalResult } from '@/models/evaluation/types';

// ── Conformance test runs ─────────────────────────────────────

export const conformanceRuns = pgTable(
  'conformance_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    models: jsonb('models').$type<string[]>().notNull(),
    results: jsonb('results').$type<ConformanceResult[]>().notNull(),
    summary: jsonb('summary')
      .$type<{ passed: number; failed: number; skipped: number; totalMs: number }>()
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index('conformance_runs_user_id_idx').on(table.userId),
    createdAtIdx: index('conformance_runs_created_at_idx').on(table.createdAt),
  })
);

// ── Evaluation runs ───────────────────────────────────────────

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    model: text('model').notNull(),
    datasetName: text('dataset_name'),
    evaluators: jsonb('evaluators').$type<string[]>().notNull(),
    results: jsonb('results').$type<EvalResult[]>().notNull(),
    summary: jsonb('summary')
      .$type<Record<string, { mean: number; passRate: number; count: number }>>()
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index('eval_runs_user_id_idx').on(table.userId),
    createdAtIdx: index('eval_runs_created_at_idx').on(table.createdAt),
  })
);

export type ConformanceRunEntry = typeof conformanceRuns.$inferSelect;
export type NewConformanceRunEntry = typeof conformanceRuns.$inferInsert;
export type EvalRunEntry = typeof evalRuns.$inferSelect;
export type NewEvalRunEntry = typeof evalRuns.$inferInsert;
