// Shapes returned by the backend (/api). Only the fields the dashboard reads are listed.

export interface Context {
  percent: number | null;
  used?: number;
  size?: number;
}

/** A kind of executor: what it is for, where it works and the system prompt that makes it so. A markdown file on the server. */
export interface Template {
  id: string;
  name: string;
  role: string;
  dir: string;
  /** The CLI it suggests (empty: the person picks). */
  type: string;
  model: string;
  prompt: string;
  /** Executors made from it. */
  usedBy?: { project: string; id: string }[];
}

export interface Member {
  key: string;
  id: string;
  type: string;
  dir: string;
  role: string | null;
  /** The id of the template it was made from. */
  template?: string | null;
  model: string | null;
  preferModel: string | null;
  preferSession: string | null;
  alive: boolean;
  busy: boolean;
  /** Its process had to be killed several times lately; it takes no work until a person recovers it. */
  unstable?: boolean;
  /** Prompts queued behind the running one. */
  waiting?: number;
  /** The queued prompts one by one, oldest first, each can be cancelled by its job id. */
  waitingJobs?: { jobId: string; text: string; at: number }[];
  /** The running task, if any: when it started (epoch ms) and what it is doing. */
  activity?: { startedAt: number; tool: string | null; toolCalls: number; openTools: number; thinking?: number } | null;
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
  /** Messages sent while a turn runs, waiting their turn (oldest first). */
  queued?: string[];
  /** Compact the conversation at this many tokens; null: never. */
  compactAt?: number | null;
  /** How many times the current conversation was compacted. */
  compactions?: number;
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
  role: 'user' | 'assistant' | 'tool' | 'error' | 'thought';
  ts?: string;
  jobId?: string;
  /** tool: what it was given / what it returned (shortened) */
  input?: string | null;
  output?: string | null;
  /** thought: size of the whole reasoning */
  chars?: number;
  text?: string;
  error?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  /** The task this run belongs to, and which attempt it is. */
  taskId?: string;
  attempt?: number;
  /** error: the daemon stopped while this task ran (there is no real duration) */
  interrupted?: boolean;
  /** assistant / thought: when this piece began; `piece`: said before a tool call, not the end of the run */
  startedAt?: string;
  piece?: boolean;
}

/** The turn that is running now: since when, and what it is doing. */
export interface Turn {
  startedAt: number;
  phase: string;
}

/** What the conversation view draws, top to bottom. */
export type Item =
  | { id: string; kind: 'user' | 'assistant' | 'error'; text: string; who?: string; live?: boolean; note?: string; tookMs?: number; tookLabel?: string; at?: number; ack?: boolean }
  /** The reasoning an executor wrote before answering. */
  | { id: string; kind: 'thought'; text: string; chars?: number; live?: boolean }
  /** A task the dispatcher handed to an executor (its agent_run call and result as one line). */
  | { id: string; kind: 'dispatch'; agent: string; prompt: string; state: 'run' | 'done' | 'fail'; toolCallId?: string; attempt?: number; maxAttempts?: number; reply?: string; startedAt?: number; tookMs?: number; queued?: boolean; ahead?: number }
  | { id: string; kind: 'tool'; name: string; detail: string; result: boolean; toolCallId?: string; state?: 'run' | 'done' | 'fail'; startedAt?: number; endedAt?: number };
