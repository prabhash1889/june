// Spoken-friendly mapping for model-API failures (2.5). Raw bodies ("the model
// API returned 401: {\"error\":{...}}") were fed straight to TTS - a JSON blob
// read aloud is useless and leaks internals. Both brains map the status to one
// short sentence for speech and keep the raw body in the log.

/** A short, speakable sentence for a model-API HTTP status, or null if the status
 *  has no special-cased line (caller falls back to a generic message). Pure. */
export function friendlyApiError(status: number): string | null {
  if (status === 401 || status === 403) return "My API key was rejected. Check the key in settings.";
  if (status === 429) return "The model is rate-limited right now. Give it a moment and try again.";
  if (status === 404) return "I couldn't find that model or endpoint. Check the model name in settings.";
  if (status >= 500 && status < 600) return "The model service is having trouble. Try again in a moment.";
  return null;
}

/** Pull a recognizable HTTP status out of an SDK/error message when the brain
 *  doesn't hand us the code directly (the Claude SDK surfaces API errors as text).
 *  ponytail: a regex over the message, not structured parsing - the SDK's error
 *  shape isn't part of its contract, so match loosely and fall back generically. */
export function statusFromMessage(message: string): number | null {
  const m = message.match(/\b(401|403|404|429|5\d\d)\b/);
  return m ? Number(m[1]) : null;
}
