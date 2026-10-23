/**
 * The onboarding guide's shapes (docs/ONBOARDING.md). Shared by the backend
 * (which reports `OnboardingState`) and the web guide (which asks the
 * questions, builds the plan and runs it). Pure types, no imports.
 */

/** What someone wants Octipus for. Each adds its own sections to the guide. */
export type UseCaseId = 'development' | 'company' | 'product' | 'research';

export type AnswerValue = string | boolean | string[];
export type Answers = Record<string, AnswerValue | undefined>;

/** What is already in place, so the guide can skip or prefill. Every part is best-effort. */
export interface OnboardingState {
  isAdmin: boolean;
  /** The install-wide "setup finished" flag (`_system.setupComplete`). */
  setupComplete: boolean;
  models: {
    /** Every text lane has a primary model. */
    textReady: boolean;
    embeddingReady: boolean;
    /** `verify` is bound to a different model from `build`. */
    verifySeparate: boolean;
    /** Model config names (admins only; empty for others). */
    names: string[];
    /** Providers with a stored API key (admins only). */
    providersWithKey: string[];
    /** Lane → primary model name (admins only). */
    byTopic: Record<string, string | null>;
  };
  /** CLI coding agents on this host (admins only). */
  cliTools: Array<{ name: string; modelId: string; available: boolean }>;
  ollama: { url: string; reachable: boolean };
  workspaces: Array<{ id: string; name: string; slug: string; kind: string; isDefault: boolean }>;
  /** The caller's connected mailbox. */
  mailbox: 'google' | 'microsoft' | null;
  /** The install has an OAuth client for these (needed before anyone can connect a mailbox). */
  oauthClients: { google: boolean; microsoft: boolean };
  connectors: Array<{ id: string; name: string; connected: boolean }>;
  channels: {
    /** Bots the server runs (a token is configured). */
    configured: string[];
    /** Chats the caller linked to their account. */
    linked: string[];
  };
  heartbeat: { serverEnabled: boolean; enabled: boolean; watchEmail: boolean; intervalMinutes: number | null; timezone: string };
  /** Stored levels for the tool actions background agents need. */
  permissions: { tasksWrite: string; messagingSend: string };
  standingInstructions: boolean;
  roleAgents: Array<{ role: string; enabled: boolean; pipelineTemplate: string | null }>;
  pipelineTemplates: Array<{ id: string; name: string }>;
  /** MCP server names (admins only). */
  mcpServers: string[];
  /** The folder agents work in (admins only). */
  workspaceRoot: string | null;
  /**
   * Modules (docs/MODULES.md): the ids that are on, and the modules each use
   * case switches on. The guide's first step turns on the ones missing.
   */
  modules: {
    enabled: string[];
    byUseCase: Partial<Record<UseCaseId, Array<{ id: string; title: string }>>>;
    /** Every module, for the guide's picker (admins). */
    available?: Array<{ id: string; title: string; description: string }>;
  };
  progress: OnboardingProgress;
}

/** Per user, in `users.preferences.onboarding`. Never holds a secret answer. */
export interface OnboardingProgress {
  /** Hidden from the home page. */
  dismissed?: boolean;
  useCases?: UseCaseId[];
  /** The last answers, minus secrets, so a return visit picks up where it left. */
  answers?: Answers;
  completedAt?: string;
}

export type QuestionKind = 'yesno' | 'choice' | 'multi' | 'text' | 'longtext' | 'secret' | 'list';

export interface QuestionOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface Question {
  id: string;
  prompt: string;
  help?: string;
  kind: QuestionKind;
  options?: QuestionOption[] | ((s: OnboardingState, a: Answers) => QuestionOption[]);
  placeholder?: string;
  /** Asked only when this holds. Absent = always. */
  when?: (a: Answers, s: OnboardingState) => boolean;
  /** The starting answer. */
  initial?: (s: OnboardingState, a: Answers) => AnswerValue | undefined;
  /** What is already set up, said above the question; the answer still counts. */
  alreadyDone?: (s: OnboardingState, a: Answers) => string | null;
}

export interface Section {
  id: string;
  title: string;
  intro: string;
  /** Which use cases bring it in; 'all' = always. */
  useCases: 'all' | UseCaseId[];
  /** Only for admins (install-wide settings). Others see `nonAdminNote` instead, when set. */
  adminOnly?: boolean;
  nonAdminNote?: string;
  questions: Question[];
}

export interface UseCase {
  id: UseCaseId;
  title: string;
  summary: string;
  /** What it sets up, in a few words each. */
  sets: string[];
}

export interface ApiCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Under /api. */
  path: string;
  body?: unknown;
}

interface StepBase {
  id: string;
  title: string;
  detail?: string;
  /** Skipped when one of these did not succeed. */
  dependsOn?: string[];
}

/** One thing the guide does, or asks the person to do, when they press Set up. */
export type PlanStep =
  /** A call the guide makes. `optional`: a failure is reported but stops nothing. */
  | (StepBase & { kind: 'api'; call: ApiCall; optional?: boolean; secret?: boolean; reveal?: string })
  /** A sign-in the person finishes in a popup: `start` answers `{ url }`. */
  | (StepBase & { kind: 'connect'; start: ApiCall; doneWhen: ConnectCheck })
  /** A code the person types in (a chat link code). */
  | (StepBase & { kind: 'code'; call: { method: 'POST'; path: string; field: string }; prompt: string })
  /** Something to do elsewhere; the guide links there. */
  | (StepBase & { kind: 'todo'; href: string })
  /** Already in place before the guide ran: shown as done, nothing is called. */
  | (StepBase & { kind: 'done' });

/** How the guide tells a connect step finished: a re-read of the state. */
export type ConnectCheck = { mailbox: true } | { connector: string };
