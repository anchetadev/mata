/**
 * Estimation engine for surfaces that DON'T expose token counts (claude.ai web,
 * the desktop chat). We re-tokenize the conversation text ourselves.
 *
 * Tokenizer: a published BPE (cl100k via gpt-tokenizer) used as a stand-in —
 * Anthropic's tokenizer isn't public, so these counts are approximate (~±10%).
 * Every event produced here is tagged fidelity:"estimated".
 *
 * Pure + store-free so it's testable; the store write happens in the collector.
 */

import { encode } from "gpt-tokenizer";
import type { UsageEvent } from "../store/db.js";
import type { KeyedEvent } from "./claude-code.js";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface EstimateOptions {
  /** Model the chat used. Web defaults to a Sonnet-class model; override when known. */
  model?: string;
  /** Conversation id (for grouping + stable dedup keys). */
  conversationId?: string;
  /** Event source label. */
  source?: string;
  /** Injected clock (testability). */
  now?: () => number;
}

/** Token count for a piece of text (0 for empty). */
export function countTokens(text: string): number {
  if (!text || !text.trim()) return 0;
  return encode(text).length;
}

/** Small stable string hash (FNV-1a) for dedup keys. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Turn a scraped conversation into estimated usage events — one per assistant
 * turn (assistant tokens drive energy). Input tokens for a turn are the new
 * user text since the previous assistant reply.
 */
export function estimateTurns(turns: ChatTurn[], opts: EstimateOptions = {}): KeyedEvent[] {
  const model = opts.model ?? "claude-sonnet-4-5";
  const source = opts.source ?? "claude-web";
  const now = opts.now ?? Date.now;
  const convo = opts.conversationId ?? "unknown";

  const events: KeyedEvent[] = [];
  let pendingUserTokens = 0;

  turns.forEach((t, i) => {
    if (t.role === "user") {
      pendingUserTokens += countTokens(t.text);
      return;
    }
    // assistant turn
    const outputTokens = countTokens(t.text);
    if (outputTokens === 0 && pendingUserTokens === 0) return;

    const event: UsageEvent = {
      ts: now(),
      source,
      model,
      inputTokens: pendingUserTokens,
      outputTokens,
      cachedInputTokens: 0,
      sessionId: opts.conversationId ?? null,
      fidelity: "estimated",
    };
    // Stable across re-scrapes: conversation + turn index + a content fingerprint.
    const key = `web:${convo}:${i}:${hash(`${outputTokens}:${t.text.slice(0, 200)}`)}`;
    events.push({ key, event });
    pendingUserTokens = 0;
  });

  return events;
}
