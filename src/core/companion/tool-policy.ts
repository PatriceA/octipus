const reads = ['companion__list', 'companion__read', 'companion__inspect_session','companion__read_part','companion__read_report', 'companion__heartbeat_status', 'tasks__list_tasks'];
const writes = ['companion__request_briefing','companion__update', 'companion__adopt', 'companion__start_session', 'companion__message_session', 'companion__control_session', 'companion__detect_incident', 'companion__advance_incident'];
/** A controller reaches project/maintenance execution only through scoped operations. */
export function companionControllerTools(mode: 'observe' | 'coordinate' | 'repair', enabled: boolean, userTurn: boolean) {
  const discovery = userTurn ? ['companion__find_sessions', 'companion__read_session'] : [];
  const personalTaskWrites = userTurn ? ['tasks__create_task','tasks__add_tasks'] : [];
  return new Set([...reads, ...discovery, ...personalTaskWrites, ...(enabled && mode !== 'observe' ? [...writes, ...(mode === 'repair' ? ['companion__verify_incident', 'companion__start_maintenance'] : []), ...(userTurn ? ['companion__create','companion__reopen_incident'] : [])] : []),
    'send_status_update', 'request_user_approval']);
}
