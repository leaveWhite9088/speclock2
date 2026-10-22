/** Live events from the backend (SSE), fanned out to whoever listens. */

export type LiveName = 'dispatcher.event' | 'job.started' | 'job.done' | 'agent.exit' | 'agent.forced-stop' | 'agent.recovered' | 'job.interrupted' | 'handoff.changed' | 'agent.compacted';
export interface LiveEvent {
  name: LiveName;
  /** dispatcher.event: the project it belongs to */
  project?: string;
  /** job.*: the executor key */
  agent?: string;
  /** job.*: which attempt at its task this run is */
  attempt?: number;
  maxAttempts?: number;
  data?: {
    type?: string;
    kind?: string;
    delta?: string;
    toolName?: string;
    toolCallId?: string;
    args?: unknown;
    isError?: boolean;
    result?: { content?: unknown; details?: { attempt?: number; maxAttempts?: number } };
    code?: number;
  };
}

type Handler = (e: LiveEvent) => void;
const handlers = new Set<Handler>();

export function onLive(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}
export const emitLive = (e: LiveEvent) => handlers.forEach((h) => h(e));
