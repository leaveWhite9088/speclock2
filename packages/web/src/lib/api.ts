/** Thin fetch wrapper: JSON in, JSON out, and a thrown Error carrying the backend's message. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data as T;
}

export const enc = encodeURIComponent;
/** `?project=<id>` selects a project's dispatcher on /api/dispatcher routes. */
export const pq = (project: string) => `?project=${enc(project)}`;
