-- The native conversation snapshot (up to 1M characters) gets its own column,
-- so the small context patches made on every turn no longer rewrite it.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS native_conversation jsonb;
--> statement-breakpoint
UPDATE sessions
SET native_conversation = context->'nativeConversation',
    context = context - 'nativeConversation'
WHERE context ? 'nativeConversation'
  AND jsonb_typeof(context->'nativeConversation') = 'object';
