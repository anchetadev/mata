# 👁 Mata — see your AI footprint

An **MCP server** that estimates the environmental footprint of your AI use —
**energy (kWh), miles driven in a gas car, water used for cooling, and CO₂** —
plus a **prompt-efficiency coach**. It works with any AI client (Claude, Codex,
others) because it measures token usage, not a specific vendor.

*Mata* is Tagalog for **eye** — in the spirit of seeing what's there.

> The impact math is a TypeScript port of the
> [EcoLogits](https://ecologits.ai/) life-cycle methodology (CC BY-SA 4.0).
> See [METHODOLOGY.md](METHODOLOGY.md) for sources and attribution.

---

## What we're building (explained simply)

**The problem:** Every time you talk to an AI like Claude, a powerful computer
in a big warehouse (a "data center") does the thinking. That computer burns
**electricity**. Making electricity usually creates **pollution** (carbon), and
the computer gets hot, so the data center uses **water** to cool it down. Most
people have no idea how much — it's invisible.

**Mata makes it visible.** Like a **fitness tracker for your AI use**: it counts
the AI's words and turns them into:

- ⚡ **Energy** used (in kWh, like your electric bill)
- 🚗 **Miles driven** in a gas car that would pollute the same amount
- 💧 **Water** used to cool the computers
- 🔤 **Words in and out** (tokens)

**Bonus — a prompt coach.** If you ask the AI to "make a thing" then correct it
five times, that wasted energy. Mata scores how efficiently you set up your work
(0–100) and gives tips to get more done in fewer prompts.

**Why it's different:** it doesn't care *which* AI you use — it watches the
words, so it works across Claude, Codex, and more. Everything stays on your
machine, and it stores word-counts, never your chats.

## The tech stack (explained simply)

A **kitchen** that turns raw ingredients (AI word-counts) into a finished meal
(the impact numbers):

| Part | What it is | Kitchen analogy |
|---|---|---|
| **TypeScript** | The language it's written in | The language the cooks speak |
| **MCP** | The standard plug that lets AI apps use the tool | The outlet every appliance fits |
| **Impact engine** (EcoLogits port) | The math: words → energy/carbon/water | The recipe, from expert scientists |
| **Data files** | Facts about each model + each country's grid | The cookbook of ingredient facts |
| **SQLite** (built into Node) | Local database of your usage | The fridge |
| **Collectors** | Watch your AI tools and record usage | The eyes 👁 |
| **Node.js** | Runs all of it | The stove |

## Runs without AI (overhead ≈ 0)

A tool that measures AI's footprint shouldn't burn AI to do it. Mata's entire
pipeline — capturing usage, doing the math, scoring efficiency, drawing the
dashboard — is **deterministic**. Nothing in the data path calls an LLM.

| Part | What it does | AI calls? |
|---|---|---|
| Impact engine, reporting, store | Arithmetic + lookup tables | **None** |
| Efficiency scorer | Regex + heuristics | **None** |
| Log tailer / `scan_logs` | JSONL parsing | **None** |
| Proxy collector | Relays *your* traffic, reads usage off it | **None of its own** |
| Web estimator | `gpt-tokenizer` (a local, offline token counter — not a model) | **None** |
| Dashboard | Plain HTML + SVG | **None** |

Runtime dependencies are just `@modelcontextprotocol/sdk`, `gpt-tokenizer`, and
`zod` — none of which make AI or network calls.

**Run it with zero AI in the loop.** The three standalone binaries need no LLM host:

```bash
ai-impact-tail        # watch Claude Code logs and record usage
ai-impact-proxy       # capture exact usage from API clients
ai-impact-dashboard   # render the HTML dashboard
```

**One honest caveat:** if you *talk* to Mata through an AI assistant
("show me my report"), that chat turn is the **host's** LLM call — Mata's own
tools add nothing. Fittingly, Mata would measure that turn too. 🙂

---

## Installation

Requires **Node ≥ 22.5** (uses the built-in `node:sqlite` — no native build step).

```bash
git clone https://github.com/anchetadev/mata.git
cd mata
npm install
npm run build
npm test          # 36 tests
```

### Add to an MCP host

**Claude Desktop** (`claude_desktop_config.json`) or **Claude Code** (`.mcp.json` / `claude mcp add`):

```json
{
  "mcpServers": {
    "mata": { "command": "node", "args": ["/absolute/path/to/mata/dist/server.js"] }
  }
}
```

The same `dist/server.js` works in any MCP-compatible host (Cursor, Cline, etc.).

### Optional collectors (run alongside)

```bash
node dist/tail-server.js       # watch Claude Code logs, record EXACT usage live
node dist/proxy-server.js      # local proxy: capture EXACT usage from API clients
node dist/dashboard-server.js  # write a static HTML dashboard file
node dist/serve-server.js      # live dashboard at http://localhost:8799 (auto-updates)
```

For the proxy, point a client at it:

```bash
ANTHROPIC_BASE_URL=http://localhost:8788   # Claude Code, Anthropic SDK
OPENAI_BASE_URL=http://localhost:8788/v1   # Codex, OpenAI SDK
```

---

## Quick start

Already installed and built? Two commands get you from zero to seeing your
footprint:

```bash
node dist/tail-server.js     # backfills your Claude Code history, then watches live
node dist/serve-server.js    # opens a live dashboard at http://localhost:8799
```

The first reads your existing `~/.claude` logs (token counts only — never your
messages) and keeps recording new activity. The second opens your browser to an
always-current dashboard. That's ~90% of the value.

**Prefer to drive it from your AI host?** If you added Mata as an MCP server, just say:

- *"Scan my Claude Code logs"* → backfill your history
- *"Serve my live dashboard"* → get a live `localhost` URL
- *"Show my AI impact this week"* → a text report
- *"How efficient were my last 5 sessions?"* → prompt coaching

**Want to capture non-Claude-Code tools too?** Run the proxy and point a client at it:

```bash
node dist/proxy-server.js    # then set ANTHROPIC_BASE_URL / OPENAI_BASE_URL=http://localhost:8788
```

> If you installed globally (`npm link` or `npm i -g`), use the bare commands
> instead — `ai-impact-tail`, `ai-impact-serve`, `ai-impact-proxy`.

---

## Usage

Once connected, ask your host things like *"estimate the impact of a 2000-token
reply from claude-opus-4-5"* or *"show my AI impact report for this week."*

### Tools

| Tool | What it does | Try saying |
|---|---|---|
| `estimate_impact` | Impact of one request from token counts | "Estimate impact of 8k in / 2k out on gpt-4o" |
| `log_usage` | Manually record a usage event | "Log 500 output tokens from claude-haiku-4-5" |
| `report` | Totals for today/week/month/all, by model | "Show my AI impact this week" |
| `scan_logs` | Backfill exact usage from Claude Code logs | "Scan my Claude Code logs" |
| `analyze_efficiency` | Coach your recent real sessions | "How efficient were my last 5 sessions?" |
| `efficiency_score` | Score a conversation you pass in | "Score the efficiency of this chat" |
| `record_web_chat` | Record estimated usage for claude.ai chat | "Record this web conversation's impact" |
| `generate_dashboard` | Build a standalone HTML dashboard file | "Generate my impact dashboard" |
| `serve_dashboard` | Start a live, always-current dashboard server | "Serve my live dashboard" |
| `set_scenario` | conservative / midpoint / high estimate | "Set the scenario to conservative" |

Resource: `impact://methodology` — how the numbers are derived.

### CLI binaries

| Command | Purpose |
|---|---|
| `ai-impact-mcp` | The MCP server (stdio) |
| `ai-impact-tail` | Backfill + watch Claude Code logs |
| `ai-impact-proxy` | Local LLM proxy collector |
| `ai-impact-dashboard` | Generate a static HTML dashboard file |
| `ai-impact-serve` | Live, always-current dashboard web server (auto-opens browser) |

---

## How invasive is it?

Short answer: **as little as possible, and entirely on your machine.** Mata
stores **token counts and metadata — never the content of your messages** — in a
local SQLite file at `~/.ai-impact/usage.db`. No telemetry, no network calls
except the proxy forwarding to the provider *you* chose.

Each capture method is opt-in and differs in what it can see:

| Method | What it reads | What it does NOT do | Fidelity |
|---|---|---|---|
| **Claude Code tailer** (`scan_logs`, `ai-impact-tail`) | `~/.claude/projects/*.jsonl` — model, token counts, timestamps | Store your prompts/replies; send anything anywhere | **Exact** |
| **Local proxy** (`ai-impact-proxy`) | Usage from API traffic *you* route through it | Intercept anything you don't point at it; alter responses | **Exact** |
| **Efficiency coach** (`analyze_efficiency`) | Transcript text, on-demand, to detect rework/clarifications | Persist the text — it's read, scored, and discarded | Exact tokens |
| **Web estimator** (`record_web_chat`) | Conversation text you/the host pass in | Auto-read your browser; access anything unprompted | **Estimated** (re-tokenized) |

What it **cannot** see: the Claude desktop/web apps talk to Anthropic directly,
so Mata can't passively read them — the web estimator only sees what you choose
to hand it. The proxy only sees clients you explicitly repoint.

Every record is tagged `exact` or `estimated`, and estimates use a public BPE
tokenizer as a stand-in (Claude's isn't public), so they carry ~±10% error.

---

## Accuracy & honesty

These are **order-of-magnitude estimates**, good for "which of my habits cost
the most" — not carbon accounting. Closed-model parameters are inferred; consumer
surfaces are re-tokenized. The tool shows its assumptions in every result and
ships full sources in [METHODOLOGY.md](METHODOLOGY.md).

## License

Dual-licensed (see [LICENSE](LICENSE) and [NOTICE](NOTICE)):

- **Original code** (server, collectors, scorer, dashboard) — **MIT**.
- **Impact engine + vendored data** (ported from [EcoLogits](https://ecologits.ai/)) —
  **CC BY-SA 4.0** (attribution + share-alike).

Publishing guidance for your own fork: [PUBLISHING.md](PUBLISHING.md).
