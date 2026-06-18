# Sharing this MCP with the world — what to know

A practical checklist for publishing an MCP server publicly. Ordered by what
bites hardest if you skip it.

## 1. Licensing (do this first — it's already set up here)

MCPs are often built on other people's data/methodology. This one ports
**EcoLogits** (CC BY-SA 4.0), which is **share-alike**: derivative files must
stay CC BY-SA with attribution. We handle that with a dual-license split:

- Original code → **MIT** (`LICENSE`)
- Engine + vendored data → **CC BY-SA 4.0** (documented in `NOTICE`)

What this means for you:
- You **can** share, and others can use/modify it.
- Anyone modifying the engine/data must keep it CC BY-SA + credit EcoLogits.
- You **cannot** relicense the engine as pure MIT or fully proprietary.
- This is not legal advice — confirm before commercializing.

## 2. Trust & transparency (this is the #1 thing users care about)

An MCP server **runs with the user's privileges** on their machine. People are
(rightly) cautious. Earn trust by being explicit about what it touches:

| Capability | What it accesses | Default |
|---|---|---|
| `scan_logs` / tailer | Reads `~/.claude/projects/*.jsonl` (token counts only, **not** message text) | On when used |
| Proxy collector | Sees API traffic you route through it (to extract usage) | Off until you run it |
| Web estimator | Conversation text you/the host pass in | Off until invoked |
| Datastore | Local SQLite at `~/.ai-impact/usage.db` | Local only |

Selling points to state loudly in your README:
- **No telemetry. Nothing leaves the machine.** (True here — keep it true.)
- **Stores counts, never chats.**
- **No network calls** except the proxy forwarding to the provider the user chose.

If you ever add analytics or a hosted component, disclose it prominently and
make it opt-in.

## 3. Accuracy honesty

These numbers are **estimates with wide error bars** (closed-model params are
inferred; consumer surfaces are re-tokenized). Say so. Over-claiming precision
is the fastest way to lose credibility. We tag every event `exact` vs
`estimated` and ship `METHODOLOGY.md` with sources — keep that discipline.

## 4. Distribution channels

- **GitHub** — the source home. Good README, LICENSE, NOTICE, CI badge, examples.
- **npm** — lets people `npx ai-impact-mcp`. Check the name is free
  (`npm view ai-impact-mcp`); if taken, scope it (`@yourname/ai-impact-mcp`).
  `prepublishOnly` (already set) builds + tests before every publish.
- **MCP registries / directories** — submit to the official
  `modelcontextprotocol/servers` list, plus `awesome-mcp-servers`, mcp.so,
  Smithery, Glama. Each wants a clear name, description, and install snippet.
- **Desktop config** — provide the `claude_desktop_config.json` block (done).
  Optionally package as a DXT/MCP bundle for one-click install later.

## 5. Repo hygiene checklist

- [x] `LICENSE` + `NOTICE` (dual license + attribution)
- [x] `.gitignore` (no `node_modules`, `dist`, `*.db`, logs)
- [x] CI that builds + tests (`.github/workflows/ci.yml`)
- [x] `package.json`: `repository`, `bugs`, `homepage`, `author`, `files`, `engines`
- [ ] Replace `YOUR_GITHUB_USERNAME` in `package.json` with your handle
- [ ] README badges (CI status, npm version) once published
- [ ] A couple of example prompts / screenshots
- [ ] `CONTRIBUTING.md` + a code of conduct if you want outside contributors
- [ ] Tag releases with semver (`v0.1.0`) and write short release notes

## 6. Gotchas specific to this project

- **Node ≥ 22.5** required (`node:sqlite`). On 22.5–22.12 users may see an
  `ExperimentalWarning` for SQLite; document it or recommend Node 24.
- The vendored EcoLogits data **drifts** — new models appear. Plan to refresh
  `src/engine/data/*.json` periodically and note the snapshot date.
- The web parser is calibrated to claude.ai's current DOM; UI changes can break
  it. Keep the structured-`turns` path as the resilient default.

## 7. Don't publish until

```bash
npm run build && npm test     # green
npm pack --dry-run            # inspect exactly what ships (no .db, no logs, no src secrets)
```
