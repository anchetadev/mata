/**
 * Prompt-efficiency scorer ("how well did the user set things up so the work
 * took the fewest prompts?"). Deterministic heuristic over a conversation's
 * turns — no LLM call required. An optional LLM-judge pass can refine the
 * first-prompt-completeness signal later (off by default).
 *
 * This is a directional COACH, not a grade. It rewards front-loaded context and
 * penalizes rework / repeated clarification loops.
 */

export interface Turn {
  role: "user" | "assistant";
  /** Message text (used for rework/clarification detection). Optional. */
  text?: string;
  outputTokens?: number;
}

export interface EfficiencyResult {
  /** 0–100. Higher = more efficiently set up. */
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  metrics: {
    userTurns: number;
    assistantTurns: number;
    reworkSignals: number;
    clarificationQuestions: number;
    firstPromptWords: number;
    /** 0–100: how well the opening prompt front-loaded goal/constraints/specifics. */
    firstPromptCompleteness: number;
    /** Estimated assistant output tokens spent on work that got corrected. */
    reworkWastedTokens: number;
  };
  /** Human-readable, actionable suggestions. */
  tips: string[];
}

// Phrases that suggest the user is correcting course (under-specified earlier).
const REWORK_RE =
  /\b(no,? (that|this)|actually|wait,|that'?s (wrong|not)|not what i|i meant|instead|try again|revert|undo|that'?s incorrect|you misunderstood|let me rephrase)\b/i;

// Assistant asking the user for missing info.
const CLARIFY_RE =
  /\b(could you (clarify|specify)|do you want|did you mean|which (one|option|approach)|can you confirm|to clarify|what (do|should) (you|i)|a few questions)\b/i;

function gradeFor(score: number): EfficiencyResult["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

const GOAL_VERB_RE =
  /\b(build|write|create|fix|implement|add|refactor|explain|summari[sz]e|analy[sz]e|design|generate|convert|debug|review|optimi[sz]e|migrate|test)\b/i;
const CONSTRAINT_RE =
  /\b(should|must|constraint|requirement|acceptance|criteria|format|example|don'?t|do not|avoid|only|prefer|using|use\b|without|no external|in \w+ (?:language|style))\b/i;
// Specifics: code fences, file paths, URLs, quoted strings, numbers with units.
const SPECIFICS_RE = /(```|`[^`]+`|\/[\w./-]+|https?:\/\/|"[^"]+"|\b\d+\s?(?:px|ms|kb|mb|gb|lines?|rows?|cols?)\b)/i;

/** Heuristic 0–100 of how complete/actionable an opening prompt is. */
export function firstPromptCompleteness(text: string): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  const words = t.split(/\s+/).length;
  let s = 0;
  s += Math.min(40, (words / 25) * 40); // substantive length
  if (GOAL_VERB_RE.test(t)) s += 20; // a clear ask
  if (CONSTRAINT_RE.test(t)) s += 20; // constraints / acceptance criteria
  if (SPECIFICS_RE.test(t)) s += 20; // concrete specifics
  return Math.round(Math.min(100, s));
}

export function scoreEfficiency(turns: Turn[]): EfficiencyResult {
  const userTurns = turns.filter((t) => t.role === "user");
  const assistantTurns = turns.filter((t) => t.role === "assistant");

  const reworkSignals = userTurns.filter((t) => t.text && REWORK_RE.test(t.text)).length;
  const clarificationQuestions = assistantTurns.filter((t) => t.text && CLARIFY_RE.test(t.text)).length;
  const firstPrompt = userTurns[0]?.text ?? "";
  const firstPromptWords = firstPrompt.trim() ? firstPrompt.trim().split(/\s+/).length : 0;
  const completeness = firstPromptCompleteness(firstPrompt);

  // Estimate output tokens "wasted": assistant work immediately preceding a
  // course-correction is the work that got redone.
  let reworkWastedTokens = 0;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role === "user" && turns[i].text && REWORK_RE.test(turns[i].text!)) {
      for (let j = i - 1; j >= 0; j--) {
        if (turns[j].role === "assistant") {
          reworkWastedTokens += turns[j].outputTokens ?? 0;
          break;
        }
      }
    }
  }

  // Start at 100 and deduct for inefficiency signals.
  let score = 100;

  // 1. Round-trips beyond a reasonable baseline. The first ~3 exchanges are
  //    "free"; each extra user turn costs a few points (work needs iteration,
  //    but lots of turns usually means under-specified setup).
  const extraTurns = Math.max(0, userTurns.length - 3);
  score -= Math.min(30, extraTurns * 4);

  // 2. Rework — the strongest signal of poor initial setup.
  score -= Math.min(30, reworkSignals * 10);

  // 3. Clarification loops — assistant had to ask for what should've been given.
  score -= Math.min(20, clarificationQuestions * 8);

  // 4. A thin opening prompt for a multi-turn task usually means missing
  //    goal/constraints. Penalize low first-prompt completeness when the
  //    conversation then ran long.
  if (userTurns.length > 2 && firstPrompt.trim() && completeness < 40) {
    score -= 10;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const tips: string[] = [];
  if (reworkSignals > 0)
    tips.push(
      `${reworkSignals} course-correction${reworkSignals > 1 ? "s" : ""} detected` +
        (reworkWastedTokens > 0 ? ` (~${reworkWastedTokens.toLocaleString()} output tokens redone)` : "") +
        ` — stating acceptance criteria up front would cut these.`,
    );
  if (clarificationQuestions > 0)
    tips.push(
      `The assistant asked ${clarificationQuestions} clarifying question${clarificationQuestions > 1 ? "s" : ""} — include those details in your opening prompt.`,
    );
  if (userTurns.length > 6)
    tips.push(`${userTurns.length} user turns — consider batching related asks into one well-scoped prompt.`);
  if (firstPrompt.trim() && completeness < 40 && userTurns.length > 2)
    tips.push(
      `Opening prompt completeness ${completeness}/100 — lead with goal + constraints + a concrete example to front-load context.`,
    );
  if (tips.length === 0) tips.push("Efficient setup — concise prompts and little rework. 👏");

  return {
    score,
    grade: gradeFor(score),
    metrics: {
      userTurns: userTurns.length,
      assistantTurns: assistantTurns.length,
      reworkSignals,
      clarificationQuestions,
      firstPromptWords,
      firstPromptCompleteness: completeness,
      reworkWastedTokens,
    },
    tips,
  };
}
