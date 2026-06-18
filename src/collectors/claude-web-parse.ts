/**
 * Best-effort parser: flattened claude.ai page text → conversation turns.
 *
 * NOTE: this is the FALLBACK path. The reliable input to the web collector is
 * structured `turns` (the browsing host extracts them from the DOM, where roles
 * are explicit). Flattened page text loses role boundaries, so this heuristic
 * is approximate and is the first thing to recalibrate against the real DOM.
 *
 * Heuristic: claude.ai renders alternating human/assistant message blocks. We
 * split on common role markers; if none are found we can't reliably segment and
 * return a single assistant block (so at least output tokens are counted).
 *
 * Calibrated against the real claude.ai DOM (2026-06): message bubbles are
 * heading elements whose accessible name is prefixed "You said:" (user) or
 * "Claude responded:" (assistant). The reliable extraction reads those headings
 * from the accessibility tree (read_page/find) and passes structured turns;
 * note that flattened get_page_text drops the "You said:" prefix on user turns,
 * which is why structured `turns` are strongly preferred over this fallback.
 */

import type { ChatTurn } from "./estimate.js";

// Role labels seen in claude.ai's accessibility tree / copied transcripts.
const ROLE_MARKER =
  /^\s*(You said:|You:|Human:|Assistant:|Claude responded:|Claude said:|Claude:)\s*/i;

function roleOf(marker: string): "user" | "assistant" {
  return /you|human/i.test(marker) ? "user" : "assistant";
}

/** Parse flattened transcript text into turns (best-effort). */
export function parseWebTranscript(pageText: string): ChatTurn[] {
  const lines = pageText.split(/\r?\n/);
  const turns: ChatTurn[] = [];
  let current: ChatTurn | null = null;

  for (const line of lines) {
    const m = ROLE_MARKER.exec(line);
    if (m) {
      if (current && current.text.trim()) turns.push({ ...current, text: current.text.trim() });
      current = { role: roleOf(m[1]), text: line.slice(m[0].length) };
    } else if (current) {
      current.text += "\n" + line;
    }
  }
  if (current && current.text.trim()) turns.push({ ...current, text: current.text.trim() });

  // No role markers found: treat the whole blob as one assistant message so the
  // output tokens are at least estimated, and signal low confidence via length.
  if (turns.length === 0 && pageText.trim()) {
    return [{ role: "assistant", text: pageText.trim() }];
  }
  return turns;
}
