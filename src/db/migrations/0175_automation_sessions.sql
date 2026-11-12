-- Background workers need a durable execution context, not a personal chat.
-- Personal session paths already select kind='chat'; room access remains separate.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_kind_chk;
--> statement-breakpoint
ALTER TABLE sessions ADD CONSTRAINT sessions_kind_chk CHECK (kind IN ('chat','room','automation'));
