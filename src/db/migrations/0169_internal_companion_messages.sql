-- Retain internal handoffs for audit/report access without displaying them as chat.
UPDATE messages m SET metadata=coalesce(m.metadata,'{}'::jsonb)||'{"visibility":"internal"}'::jsonb
WHERE EXISTS (SELECT 1 FROM agents a WHERE a.id=m.agent_id AND coalesce(a.metadata->>'companionBriefing','false')='true')
OR (m.role='user' AND m.metadata->>'trigger'='monitor' AND (
  EXISTS (SELECT 1 FROM companion_actions a WHERE a.session_id=m.session_id AND a.kind='request_briefing' AND a.message=m.content)
  OR (m.content LIKE 'Companion supervision update.%' AND EXISTS (
    SELECT 1 FROM sessions s WHERE s.id=m.session_id AND s.context->'companionSupervisor' IS NOT NULL))
));
