// Shapes returned by the backend (/api). Only the fields the dashboard reads are listed.

export interface Context {
  percent: number | null;
  used?: number;
  size?: number;
}

export interface Member {
  key: string;
  id: string;
  type: string;
  dir: string;
  role: string | null;
  model: string | null;
  preferModel: string | null;
  preferSession: string | null;
  alive: boolean;
  busy: boolean;
  /** Its process had to be killed several times lately; it takes no work until a person recovers it. */
  unstable?: boolean;
  /** Its last task was cut off by a daemon shutdown; cleared when it gets new work. */
  interrupted?: { jobId: string; startedAt: string; prompt: string | null } | null;
  lastError?: string | null;
  context?: Context | null;
  /** Compact the conversation once it holds this many tokens; null for never. */
  compactAt?: number | null;
  canCompact?: boolean;
  compactions?: number;
}

export interface DispatcherInfo {
  alive: boolean;
  busy: boolean;
  context?: Context | null;
}

export interface Project {
  id: string;
  name: string;
  root: string;
  instances: Member[];
  dispatcher?: DispatcherInfo;
}

export interface Limits {
  alive: number;
  maxProcesses: number;
  global?: number;
  idleMinutes: number;
}

export interface ProjectsResponse {
  projects: Project[];
  limits: Limits;
}

export interface ModelOption {
  value: string;
  name?: string;
}
export interface ModelCatalog {
  models: ModelOption[];
  default: string | null;
}
export interface DispatcherModels {
  models: ModelOption[];
  current: string | null;
  hiddenWithoutCredentials?: number;
}

export interface Session {
  sessionId: string;
  title?: string | null;
  label?: string | null;
  updatedAt?: string | null;
  active?: boolean;
}
export interface DispatcherSession extends Session {
  file: string;
}

export interface Llm {
  provider: string;
  baseUrl: string;
  models: { id: string }[];
}

/** One row of an executor's transcript. */
export interface TranscriptEntry {
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  text?: string;
  error?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  /** The task this run belongs to, and which attempt it is. */
  taskId?: string;
  attempt?: number;
}

/** What the conversation view draws, top to bottom. */
export type Item =
  | { id: string; kind: 'user' | 'assistant' | 'error'; text: string; who?: string; live?: boolean; note?: string }
  /** A task the dispatcher handed to an executor (its agent_run call and result as one line). */
  | { id: string; kind: 'dispatch'; agent: string; prompt: string; state: 'run' | 'done' | 'fail'; toolCallId?: string; attempt?: number; maxAttempts?: number; reply?: string }
  | { id: string; kind: 'tool'; name: string; detail: string; result: boolean; toolCallId?: string; state?: 'run' | 'done' | 'fail' };
