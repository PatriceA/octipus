import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/** Clef's answer for one mail, as the triage gate saw it. `rubric` ties it to the question wording. */
export interface ClefObservation {
  model: string;
  rubric: string;
  priority: 'low' | 'normal' | 'high';
  priorityConfidence: number;
  category: string;
  categoryConfidence: number;
  at: string;
}

/**
 * The email triage training set (core/email/triage-labels.ts): per mail, what
 * the decision model answered and the label to measure it against — set by
 * the owner (`user`) or by a reference model (`model`). A user label is never
 * overwritten by a model.
 *
 * Unlike email_handled this stores sender, subject and a short snippet: the
 * decision model sees a user's labelled mail from the same sender as worked
 * examples, and the review queue shows what is being labelled. Deleted with
 * the user.
 */
export const emailTriageLabels = pgTable('email_triage_labels', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** 'google' | 'microsoft' */
  provider: text('provider').notNull(),
  messageId: text('message_id').notNull(),
  fromEmail: text('from_email').notNull(),
  subject: text('subject').notNull(),
  snippet: text('snippet').notNull(),
  clef: jsonb('clef').$type<ClefObservation>(),
  labelPriority: text('label_priority').$type<'low' | 'normal' | 'high'>(),
  labelCategory: text('label_category'),
  labelSource: text('label_source').$type<'user' | 'model'>(),
  /** The reference model's row name, for `model` labels. */
  labelModel: text('label_model'),
  labeledAt: timestamp('labeled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('email_triage_labels_message_idx').on(t.userId, t.provider, t.messageId),
  index('email_triage_labels_sender_idx').on(t.userId, t.fromEmail),
]);

export type EmailTriageLabel = typeof emailTriageLabels.$inferSelect;
