/** Tool input and output as short text for the transcript, from whatever shape an agent reports them in. */

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)} …` : s);

/** `rawInput` / `rawOutput`: a string or a JSON value. */
export function inputText(raw, max = 1500) {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw.trim() ? clip(raw, max) : null;
  try {
    return clip(JSON.stringify(raw, null, 2), max);
  } catch {
    return null;
  }
}

/** The text of a finished tool call: ACP `content` blocks first, `rawOutput` otherwise. */
export function outputText(update, max = 3000) {
  const parts = (Array.isArray(update?.content) ? update.content : [])
    .map((c) => c?.content?.text ?? c?.text ?? '')
    .filter(Boolean);
  if (parts.length) return clip(parts.join('\n'), max);
  return inputText(update?.rawOutput, max);
}
