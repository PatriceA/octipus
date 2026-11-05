const reads = ['companion__list', 'companion__read', 'companion__inspect_session','companion__read_part'];
const writes = ['companion__update', 'companion__adopt', 'companion__start_session', 'companion__message_session', 'companion__control_session', 'companion__detect_incident', 'companion__advance_incident'];
/** A controller reaches project/maintenance execution only through scoped operations. */
export function companionControllerTools(mode: 'observe' | 'coordinate' | 'repair', enabled: boolean, userTurn: boolean) {
  return new Set([...reads, ...(enabled && mode !== 'observe' ? [...writes, ...(mode === 'repair' ? ['companion__verify_incident', 'companion__start_maintenance'] : []), ...(userTurn ? ['companion__create'] : [])] : []),
    'send_status_update', 'request_user_approval']);
}
