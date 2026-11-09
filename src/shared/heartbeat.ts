/** Heartbeat settings and role status shared by the API and web client. */
export interface RoleAgentRow {
  role: string;
  /** Open or in-progress tasks assigned to the role. */
  activeTasks: number;
  totalTasks: number;
  /** Effective setting: an explicit role hook, otherwise the personal heartbeat. */
  enabled: boolean;
  /** No role override: follows the personal heartbeat setting. */
  inherited: boolean;
  /** The hook that runs (the enabled one, else the oldest), or null when none exists. */
  hookId: string | null;
  /** The role is in the registry (an unknown one cannot be turned on). */
  known: boolean;
  /**
   * The pipeline template (id) the role's agent runs each task through, or
   * null when it works tasks itself (core/tasks/role-pipelines.ts).
   */
  pipelineTemplate: string | null;
}

export interface RoleAgentsView {
  roles: RoleAgentRow[];
  /** tasks/write is ALLOW for the user; without it a role turn cannot touch the board. */
  boardWritesAllowed: boolean;
  /** The server's heartbeat master switch (`heartbeat.enabled`); off, no role agent runs. */
  heartbeatEnabled: boolean;
}
