const reads = ['companion__list', 'companion__read', 'companion__inspect_session'];
const writes = ['companion__update', 'companion__adopt', 'companion__start_session', 'companion__message_session', 'companion__control_session'];
/** A controller reaches project/maintenance execution only through scoped operations. */
export function companionControllerTools(mode: 'observe' | 'coordinate' | 'repair', enabled: boolean, userTurn: boolean) {
  return new Set([...reads, ...(enabled && mode !== 'observe' ? [...writes, ...(userTurn ? ['companion__create'] : [])] : []),
    'send_status_update', 'request_user_approval']);
}
