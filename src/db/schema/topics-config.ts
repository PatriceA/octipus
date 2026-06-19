import { integer, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Per-topic configuration extras that the model card can't hold — kept keyed by
 * topic (global, not per-model) so they apply whichever model currently serves
 * the topic. Primary/backup model binding still lives on `model_config`
 * (`topicRoles`); this table holds only the per-topic overrides:
 *
 *   - `executorModel`  optional planner→executor split (W9): when set, a swarm
 *                      child spawned for this topic resolves to this model id
 *                      instead of the topic's primary. Empty ⇒ planner==executor.
 *   - `temperature` / `maxTokens`  optional per-topic sampling overrides applied
 *                      at completion time, taking precedence over the model's
 *                      own defaults. Null ⇒ use the model defaults.
 *
 * A row exists only for topics a user has customized; absent ⇒ all defaults.
 */
export const topicsConfig = pgTable('topics_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  topic: text('topic').notNull().unique(),
  executorModel: text('executor_model'),
  temperature: real('temperature'),
  maxTokens: integer('max_tokens'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type TopicConfig = typeof topicsConfig.$inferSelect;
export type NewTopicConfig = typeof topicsConfig.$inferInsert;
