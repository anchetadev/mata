/**
 * Pure usage extractors for the proxy collector. Given a provider and a
 * response body (JSON object or raw SSE text), pull out exact token counts and
 * the model. No I/O — fully testable.
 *
 * Anthropic Messages API and OpenAI Chat/Responses APIs report usage
 * differently and split it across streaming events, so each provider gets its
 * own extractor.
 */

export type Provider = "anthropic" | "openai" | "unknown";

export interface ParsedUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** Detect provider from the request path (works for SDK base-URL overrides). */
export function detectProvider(path: string): Provider {
  if (/\/messages\b/.test(path)) return "anthropic";
  if (/\/(chat\/completions|responses|completions)\b/.test(path)) return "openai";
  return "unknown";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ── Non-streaming JSON bodies ──────────────────────────────────────────────

export function parseJsonUsage(provider: Provider, body: unknown): ParsedUsage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;

  if (provider === "anthropic") {
    const u = b.usage;
    if (!u) return null;
    return {
      model: String(b.model ?? "unknown"),
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cachedInputTokens: num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens),
    };
  }

  if (provider === "openai") {
    const u = b.usage;
    if (!u) return null;
    // Chat Completions: prompt_tokens/completion_tokens. Responses API:
    // input_tokens/output_tokens. Support both.
    const input = num(u.prompt_tokens) || num(u.input_tokens);
    const output = num(u.completion_tokens) || num(u.output_tokens);
    const cached = num(u.prompt_tokens_details?.cached_tokens) || num(u.input_tokens_details?.cached_tokens);
    return {
      model: String(b.model ?? "unknown"),
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
    };
  }

  return null;
}

// ── Streaming SSE bodies ───────────────────────────────────────────────────

/** Extract the JSON `data:` payloads from an SSE text blob. */
function* sseData(text: string): Generator<any> {
  for (const line of text.split(/\r?\n/)) {
    const m = /^data:\s*(.*)$/.exec(line);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      yield JSON.parse(payload);
    } catch {
      /* skip non-JSON keep-alives */
    }
  }
}

/**
 * Parse usage out of a full SSE stream.
 *
 * Anthropic: `message_start` carries the model + input tokens (and cache), and
 * the running output token count lands in `message_delta.usage.output_tokens`.
 * OpenAI: with `stream_options.include_usage`, a late chunk carries `usage`.
 */
export function parseSseUsage(provider: Provider, text: string): ParsedUsage | null {
  if (provider === "anthropic") {
    let model = "unknown";
    let inputTokens = 0;
    let cached = 0;
    let outputTokens = 0;
    let saw = false;
    for (const ev of sseData(text)) {
      if (ev.type === "message_start" && ev.message) {
        saw = true;
        model = String(ev.message.model ?? model);
        const u = ev.message.usage ?? {};
        inputTokens = num(u.input_tokens);
        cached = num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
        outputTokens = num(u.output_tokens);
      } else if (ev.type === "message_delta" && ev.usage) {
        saw = true;
        outputTokens = num(ev.usage.output_tokens) || outputTokens;
      }
    }
    return saw ? { model, inputTokens, outputTokens, cachedInputTokens: cached } : null;
  }

  if (provider === "openai") {
    let last: ParsedUsage | null = null;
    for (const ev of sseData(text)) {
      if (ev.usage) {
        const parsed = parseJsonUsage("openai", ev);
        if (parsed) last = parsed;
      }
    }
    return last;
  }

  return null;
}

/** Convenience: parse either form, choosing by content-type. */
export function parseUsage(provider: Provider, isSse: boolean, body: string): ParsedUsage | null {
  if (provider === "unknown") return null;
  if (isSse) return parseSseUsage(provider, body);
  try {
    return parseJsonUsage(provider, JSON.parse(body));
  } catch {
    return null;
  }
}
