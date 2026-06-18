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

export function scoreEfficiency(turns: Turn[]): EfficiencyResult {
  const userTurns = turns.filter((t) => t.role === "user");
  const assistantTurns = turns.filter((t) => t.role === "assistant");

  const reworkSignals = userTurns.filter((t) => t.text && REWORK_RE.test(t.text)).length;
  const clarificationQuestions = assistantTurns.filter((t) => t.text && CLARIFY_RE.test(t.text)).length;
  const firstPrompt = userTurns[0]?.text ?? "";
  const firstPromptWords = firstPrompt.trim() ? firstPrompt.trim().split(/\s+/).length : 0;

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

  // 4. A one-line opening prompt for a multi-turn task usually means missing
  //    goal/constraints. Reward a substantive first prompt; lightly penalize a
  //    very thin one when the conversation then ran long.
  if (userTurns.length > 2 && firstPromptWords > 0 && firstPromptWords < 12) {
    score -= 10;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const tips: string[] = [];
  if (reworkSignals > 0)
    tips.push(
      `${reworkSignals} course-correction${reworkSignals > 1 ? "s" : ""} detected — stating acceptance criteria up front would cut these.`,
    );
  if (clarificationQuestions > 0)
    tips.push(
      `The assistant asked ${clarificationQuestions} clarifying question${clarificationQuestions > 1 ? "s" : ""} — include those details in your opening prompt.`,
    );
  if (userTurns.length > 6)
    tips.push(`${userTurns.length} user turns — consider batching related asks into one well-scoped prompt.`);
  if (firstPromptWords > 0 && firstPromptWords < 12 && userTurns.length > 2)
    tips.push("Your first prompt was short; leading with goal + constraints + examples front-loads context.");
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
    },
    tips,
  };
}
