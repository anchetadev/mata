# AI Impact MCP

An **MCP server** that estimates the environmental footprint of your AI use —
**energy (kWh), miles driven in a gas car, water used for cooling, and CO₂** —
plus a **prompt-efficiency score**. It works with any AI client (Claude, Codex,
others) because it measures token usage, not a specific vendor.

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

**Our tool makes it visible.** It's like a **fitness tracker, but for your AI
use.** Just like a Fitbit counts your steps and turns them into "calories
burned," this tool counts the AI's words and turns them into:

- ⚡ **Energy** used (in kWh, like your electric bill)
- 🚗 **Miles driven** in a gas car that would pollute the same amount (the
  relatable part!)
- 💧 **Water** used to cool the computers
- 🔤 **Words in and out** (tokens)

**The bonus feature** is like a coach for your homework. If you ask the AI to
"make a thing," then have to correct it five times, that wasted a lot of energy.
The tool gives you an **efficiency score** (0–100) and tips like *"say exactly
what you want up front to avoid the back-and-forth."*

**Why it's special:** It doesn't care *which* AI you use — Claude, Codex,
anything. It watches the words, so it works with all of them. (Other tools, like
EcoLogits, only work if you're a programmer writing special code — ours is meant
to just watch what you actually do.)

---

## The tech stack (explained simply)

Think of the project as a **kitchen** that turns raw ingredients (AI
word-counts) into a finished meal (the impact numbers):

| Part | What it is | Kitchen analogy |
|---|---|---|
| **TypeScript** | The language we write everything in | The language the cooks speak |
| **MCP (Model Context Protocol)** | The standard "plug" that lets AI apps use our tool | The outlet every appliance fits |
| **The engine** (EcoLogits port) | The math turning words → energy/carbon/water | The **recipe**, from expert scientists |
| **Two data files** | Facts about each AI model and each country's power grid | The **cookbook** of ingredient facts |
| **SQLite** (built into Node) | A tiny database that remembers your usage, on your computer | The **fridge** where we store ingredients |
| **The tools** | The buttons an AI can press: estimate, log, report, score, settings | The **kitchen appliances** |
| **Node.js** | The program that runs all of it | The **stove** everything cooks on |

Two things worth knowing:

- **Everything stays on your computer.** We store only word-counts, never your
  actual chats. (Like a fridge only you can open.)
- **We borrowed the recipe honestly.** The math comes from a respected
  non-profit (EcoLogits). Their recipe has a sharing rule (the CC BY-SA
  license), so we credit them.

---

## Try it (developer preview)

Requires **Node ≥ 22.5** (uses the built-in `node:sqlite` — no native build step).

```bash
npm install
npm run build
npm test          # 31 tests
```

Add the MCP server to Claude Desktop / Claude Code (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ai-impact": { "command": "node", "args": ["/absolute/path/to/dist/server.js"] }
  }
}
```

Optional collectors:

```bash
node dist/proxy-server.js   # local proxy: capture exact usage from API clients
node dist/tail-server.js    # watch Claude Code logs and record exact usage
```

> Full install/usage docs and a "how invasive is it?" breakdown are still being
> written — see **Coming later**.

## License

Dual-licensed (see [LICENSE](LICENSE) and [NOTICE](NOTICE)):

- **Original code** (MCP server, collectors, scorer) — **MIT**.
- **Impact engine + vendored data** (ported from [EcoLogits](https://ecologits.ai/)) —
  **CC BY-SA 4.0** (attribution + share-alike). Modifications to those files
  must stay CC BY-SA.

## Coming later

This README will grow to include:

- **Installation** — how to add it to Claude Desktop / Claude Code / other hosts
- **Usage** — the available tools and example prompts
- **How invasive is it?** — exactly what each capture method can and can't see,
  and what stays private

_(Tabled for now — see [METHODOLOGY.md](METHODOLOGY.md) for the science in the
meantime.)_
