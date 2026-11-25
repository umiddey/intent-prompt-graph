# Plan: Decision & Path Graph Architecture and Dark-Mode DAG UI

**Status**: COMPLETE
**Created**: 2026-11-22 18:00 CET
**Memory file**: `docs/memory/20261122_1800_decision_path_graph.md`

## Thought Process & Context (Prior Conversation)

Before writing this plan, we audited the existing `intent-prompt-graph` implementation and inspected 4 real OMP sessions (`01a20417`, `01a202af`, `01a20396`, `01a201fa`) to understand how the owner actually interacts with coding agents.

### Why the previous implementation failed on all fronts
1. **No intent grouping out of the box**: Without `labeler.baseUrl` + `labeler.model` in `~/.config/intent-prompt-graph/config.json`, the page showed a red error banner and dumped everything into `"Unsorted turns"` hard-capped at 12 cards (`UNSORTED_SHOWN = 12`).
2. **Flat starburst instead of a causal graph**: `web/layout.ts` placed every turn on a golden-angle Vogel spiral (`i * 137.508°`) with every edge connecting directly to `(0, 0)`. Consecutive Q&A turns (`openedBy`) were scattered 137.5° apart with zero turn-to-turn causal edges.
3. **Wrong data model for real sessions**: Real sessions are not flat bags of "topics" — they are **decision trees**:
   - Design sessions (`01a20417`) explore multiple options, adopt some, reject others with explicit reasons (*"commit time is post token usage, so it is wasting tokens"*), and converge on a chosen architecture + constraints.
   - Review/debate sessions (`01a202af`) contain repetitive `chk agn` / `chk now` iteration loops (10 raw turns = 1 milestone), audit catches, side questions (*"what is gross rent?"*), and multi-item debates where some items are kept and others rejected.
   - Orchestration sessions (`01a201fa`, `01a20396`) contain heavy guard/polling noise (`main-guard`, repeated blocker status) plus sharp owner overrides that kill one branch and prioritize another.
4. **Visual & UX failures**: `web/style.css` shipped light mode (`#faf9f6`) despite `docs/phases.md` specifying dark mode; `web/app.ts` wiped `innerHTML` every 15 seconds (destroying text selection and scroll in the right panel); `"Sorting…"` chip was unclickable; `Follow latest` turned off on every click anywhere.

### Approved Prototype
We built an interactive dark-mode Decision & Path Graph prototype (`decision-graph-prototype.html`) using real data from `01a20417` and `01a202af`. The owner approved it unconditionally ("fucking perfection. you have my consent to do this").

## Architecture Overview

- **Semantic Graph Model (`src/model.ts`)**:
  - `NodeKind`: `"goal" | "chosen" | "rejected" | "option" | "decision" | "loop" | "side"`
  - `EdgeKind`: `"chosen" | "rejected" | "option" | "decision" | "loop" | "side"`
  - `GraphNode`: `{ id, kind, badge, title, desc, rationaleLabel, rationale, turnIds, at, rounds? }`
  - `GraphEdge`: `{ id, from, to, kind, label? }`
  - `SessionGraph`: `{ title, nodes, edges, mode: "llm" | "heuristic" }`
  - `ServerEvent`: `snapshot` (includes `turns`, `graph`, `labelerError?`), `turn`, `graph`, `labeler`, `reset`.
- **Two-tier Graph Extraction**:
  1. **Deterministic Heuristic Builder (`src/heuristic.ts`)**: Always runs immediately (0 ms latency, no API key needed). Filters/collapses guard/polling noise and repetitive `chk agn` loops into `loop` nodes, pairs owner prompts with `openedBy` replies, detects owner pushbacks/rejections (`decision`/`rejected` forks) and side clarifications (`side` branches), and outputs a connected DAG. Guarantees the app is genuinely useful out of the box.
  2. **LLM Decision-Graph Extractor (`src/labeler.ts`)**: When `config.labeler` (`baseUrl` + `model`) is configured, sends I5-redacted turns to the OpenAI-compatible `/chat/completions` endpoint to extract rich decision nodes (including unchosen options offered by the agent, explicit rejection reasons, collapsed loops, and labeled causal edges), strictly validated and persisted in `src/store.ts`.
- **Layered DAG Layout (`web/layout.ts`)**:
  - Pure function `layoutGraph(nodes, edges)` computing topological left-to-right columns (layers) and collision-free vertical rows, keeping the main spine (`goal` → `decision` → `chosen` → `loop`) centered while fanning `rejected`, `option`, and `side` branches cleanly above/below their parent with zero overlap.
- **Dark-Mode Decision Graph UI (`web/index.html`, `web/style.css`, `web/view.ts`, `web/app.ts`)**:
  - Obsidian dark palette (`#0c0e13` dot-grid canvas, `#11141c` panels) matching the approved prototype.
  - Top bar with session title, live connection indicator, `LLM` / `Heuristic` mode pill, and color legend.
  - Left sidebar: Executive Summary (**Session Overview**, **Chosen Path & Outcomes**, **Rejected / Unchosen Paths** with click-to-jump).
  - Center canvas: Pan/zoom cubic-Bezier directed SVG edges with edge labels, semantic HTML node cards (strikethrough + dashed red for rejected, dotted slate for unchosen options), floating bottom bar (`All paths`, `Chosen path only`, `Decisions & Rejections`, `Follow latest`, `Fit`, `100%`).
  - Right Inspector panel: Selected node badge, title, rationale box (**Why chosen / Why rejected**), and full **Source Transcript Excerpts** with actions — **only re-rendered when the selected node or its turns actually change** (no 15-second `innerHTML` wipe!).

---

## Phases

### Phase 1: Core Data Model, Heuristic DAG Builder, LLM Graph Extractor, Store & Session Pipeline — DONE
**Why**: Establishes the new Decision & Path Graph data contract, ensures every session produces a meaningful connected DAG immediately via heuristics (even without an API key), and upgrades the LLM labeler + persistence + live SSE session pipeline to produce and stream `SessionGraph` updates while preserving I1 (live turns < 1s) and I5 (privacy redaction).
- [x] Update `src/model.ts` with `NodeKind`, `EdgeKind`, `GraphNode`, `GraphEdge`, `SessionGraph`, and updated `ServerEvent`.
- [x] Create `src/heuristic.ts` — deterministic Decision & Path Graph builder with noise/loop collapsing, Q&A pairing, pushback/rejection detection, and side-question branching.
- [x] Update `src/labeler.ts` — LLM Decision & Path Graph extraction prompt, I5 payload builder, and strict graph output validator.
- [x] Update `src/store.ts` — persist and reload `SessionGraph` snapshots per session (preserving backward-safe parsing of old store files).
- [x] Update `src/session.ts` — emit immediate heuristic `SessionGraph` on snapshot/turn updates, and upgrade to persisted LLM `SessionGraph` asynchronously when configured.
- [x] Update/add backend unit tests (`test/heuristic.test.ts`, `test/labeler.test.ts`, `test/session.test.ts`, `test/server.test.ts`, `test/fake-labeler.ts`).
- Verification: `bun test test/tail.test.ts test/omp.test.ts test/heuristic.test.ts test/labeler.test.ts test/session.test.ts test/cli.test.ts test/server.test.ts` → 56 pass, 0 fail.

### Phase 2: Layered DAG Layout Engine & Dark-Mode Decision Graph Web UI — DONE
**Why**: Replaces the broken light-mode golden-angle starburst with the approved dark-mode layered DAG layout, executive summary sidebar, provenance inspector, and path-filtering bottom bar — and fixes all interaction bugs (15s DOM wipe, dead chips, hair-trigger Follow off).
- [x] Rewrite `web/layout.ts` as a pure layered DAG layout engine (`layoutGraph`, `edgePath`, `NODE_W`, `NODE_H`, `COL_GAP`, `ROW_GAP`) with zero-overlap guarantee.
- [x] Rewrite `web/index.html` and `web/style.css` to the approved dark-mode obsidian Decision & Path Graph layout and semantic palette.
- [x] Rewrite `web/view.ts` and `web/app.ts` to render directed Bezier edges with labels, semantic node cards, Executive Summary sidebar, non-destructive Inspector panel, bottom filter toggles (`All paths`, `Chosen path only`, `Decisions & Rejections`), Follow latest, Fit, 100%, and pan/zoom.
- [x] Update `test/layout.test.ts` and `test/view.test.ts` to verify zero-overlap DAG layout, filtering, summary derivation, and non-empty rendering.
- Verification: `bun test && bunx tsc --noEmit` → 64 pass, 0 fail, exit 0.

### Phase 3: End-to-End Verification against Real OMP Sessions & Final Polish — DONE
**Why**: Confirms the complete flow works end-to-end (daemon startup, real OMP sessions `01a20417` and `01a202af`, SSE snapshot streaming, live turn append, HTML/CSS/JS bundle build, `bun test`, `tsc --noEmit`).
- [x] Run `bun test` and `bunx tsc --noEmit` (64 pass, 0 fail, exit 0).
- [x] Run live E2E test: started `ipg serve` on an ephemeral port, hit `/health`, `/s/omp/<key>`, bundled `/_web/*` assets, and `/api/s/omp/<key>/events` against real OMP sessions `01a20417` (8 turns → 7 nodes, 8 edges, `goal/option/rejected/decision/chosen`) and `01a202af` (61 turns → 35 nodes, 41 edges, `goal/option/rejected/decision/chosen/side`), both with zero errors.
- [x] Updated `README.md` to reflect the Decision & Path Graph model and heuristic-first behavior.
- [x] Updated plan + 1:1 mapped memory file to COMPLETE.
