-- In-app notify targets are now addressed by the owner's user id
-- (`webchat:<ownerId>`, delivered to all of the owner's live web chat
-- connections; src/channels/ownership.ts). Rewrite what hooks stored before:
-- `webchat:<connection id>` (ephemeral, dead after a reconnect) and
-- `api:<anything>` (never deliverable) become `webchat:<ownerId>`.
UPDATE hooks h
SET action_config = jsonb_set(h.action_config, '{notifyChannels}', (
  SELECT COALESCE(jsonb_agg(DISTINCT CASE
    WHEN e LIKE 'webchat:%' OR e LIKE 'api:%' THEN 'webchat:' || h.user_id::text
    ELSE e END), '[]'::jsonb)
  FROM jsonb_array_elements_text(h.action_config->'notifyChannels') AS e
))
WHERE jsonb_typeof(h.action_config->'notifyChannels') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(h.action_config->'notifyChannels') AS e
    WHERE (e LIKE 'webchat:%' OR e LIKE 'api:%') AND e <> 'webchat:' || h.user_id::text
  );
--> statement-breakpoint
UPDATE hooks
SET action_config = action_config || jsonb_build_object('channelType', 'webchat', 'channelId', user_id::text)
WHERE action_config->>'channelType' IN ('webchat', 'api')
  AND (action_config->>'channelType' <> 'webchat' OR action_config->>'channelId' IS DISTINCT FROM user_id::text);
