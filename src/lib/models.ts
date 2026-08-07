/** Centralized Claude model ID constants */

export const CLAUDE_SONNET = "claude-sonnet-5";
export const CLAUDE_OPUS = "claude-opus-5";

/**
 * Extract trimmed text from a Claude response's content array.
 *
 * Reads the first `text` block wherever it sits, not content[0]: when extended
 * thinking is on, content[0] is a `thinking` block and indexing it yields "".
 * Same failure mode that silently stalled the generate-* scripts — see the
 * header in scripts/lib/claude.mjs.
 */
export function extractText(content: Array<{ type: string; text?: string }>): string {
  const block = content?.find((c) => c?.type === "text");
  return (block?.text ?? "").trim();
}

/** Strip markdown code fences (```json ... ``` or ``` ... ```) from a string. */
export function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}
