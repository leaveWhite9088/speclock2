/** Tool input and output as short text for the transcript, from whatever shape an agent reports them in. */

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)} …` : s);

/** `rawInput` / `rawOutput`: a string or a JSON value. An empty object (what some agents send before the arguments are known) is nothing. */
export function inputText(raw, max = 1500) {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw.trim() ? clip(raw, max) : null;
  if (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) return null;
  try {
    return clip(JSON.stringify(raw, null, 2), max);
  } catch {
    return null;
  }
}

/**
 * The text of a finished tool call, from whichever of these the agent gave: text blocks, a file edit (diff),
 * `rawOutput` (a string, or an object with an `output`), or only the exit code of a terminal.
 */
export function outputText(update, max = 3000) {
  const parts = [];
  for (const c of Array.isArray(update?.content) ? update.content : []) {
    if (c?.type === 'diff') parts.push(`edit ${c.path ?? ''}${typeof c.newText === 'string' ? `\n${clip(c.newText, 600)}` : ''}`.trim());
    else if (c?.content?.text ?? c?.text) parts.push(c?.content?.text ?? c?.text);
  }
  if (parts.length) return clip(parts.join('\n'), max);
  const raw = update?.rawOutput;
  if (raw && typeof raw === 'object' && typeof raw.output === 'string' && raw.output.trim()) return clip(raw.output, max);
  const text = inputText(raw, max);
  if (text) return text;
  const exit = update?._meta?.terminal_exit;
  if (exit) return `exit code ${exit.exit_code ?? '?'}${exit.signal ? `, signal ${exit.signal}` : ''}`;
  return null;
}
