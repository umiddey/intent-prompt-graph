# 20261122_1800_decision_path_graph
**Task**: Replace flat golden-angle intent spiral with Decision & Path Graph (DAG) model, heuristic + LLM extraction, and dark-mode interactive UI
**Status**: COMPLETE

## WHAT
- Phase 1 complete ✓: Decision & Path Graph data model, heuristic DAG builder, LLM graph extractor, graph store, live SSE session pipeline, and backend unit tests.
- Phase 2 complete ✓: Layered DAG layout engine (`web/layout.ts`), dark-mode obsidian Decision Graph UI (`web/index.html`, `web/style.css`, `web/view.ts`, `web/app.ts`), and layout/view unit tests.
- Phase 3 complete ✓: Live E2E verification against real OMP sessions (`01a20417`, `01a202af`), `README.md` updated, `bun test` (64 pass, 0 fail), `bunx tsc --noEmit` (exit 0).

## HOW
- Audited existing codebase and 4 real OMP sessions (`01a20417`, `01a202af`, `01a20396`, `01a201fa`).
- Designed and got owner approval on dark-mode Decision & Path Graph prototype (`decision-graph-prototype.html`).
- Implemented Phase 1 (`src/model.ts`, `src/heuristic.ts`, `src/labeler.ts`, `src/store.ts`, `src/session.ts` + backend tests).
- Implemented Phase 2 (`web/layout.ts`, `web/index.html`, `web/style.css`, `web/view.ts`, `web/app.ts` + layout/view tests).
- Verified Phase 3 end-to-end:
  - `bun test && bunx tsc --noEmit` → 64 pass, 0 fail, exit 0.
  - Live `ipg serve` E2E against `01a20417-4c90-7660-8277-d549fb426160` (8 turns → 7 nodes, 8 edges, 2 bundled `/_web/*` assets, 0 errors) and `01a202af-22cb-73b1-bc60-35a593adc9f0` (61 turns → 35 nodes, 41 edges, 0 errors).

## WHY
- The previous implementation failed on all fronts: no intent grouping without manual LLM config (degraded to 12-item unsorted ring), flat golden-angle starburst with zero causal turn-to-turn edges, light-mode CSS contradicting the dark-mode spec, and destructive 15-second `innerHTML` wipes.
- Real OMP sessions are decision trees with options proposed, paths chosen, paths rejected with reasons, repetitive review/polling loops, and side clarifications. A layered Decision & Path Graph DAG with an immediate deterministic heuristic builder + optional LLM upgrade solves both the visual model and out-of-the-box usability.

## FILES MODIFIED
- `docs/plans/immediate/20261122_1800_decision_path_graph.md`: 3-phase plan (COMPLETE)
- `docs/memory/20261122_1800_decision_path_graph.md`: 1:1 mapped memory file (COMPLETE)
- `src/model.ts`: Decision & Path Graph types (`NodeKind`, `EdgeKind`, `GraphNode`, `GraphEdge`, `SessionGraph`) and SSE protocol
- `src/heuristic.ts`: deterministic Decision & Path Graph builder with loop/noise collapsing, rejection forks, option extraction, side questions
- `src/labeler.ts`: LLM Decision & Path Graph extractor + strict validator + I5 privacy redaction
- `src/store.ts`: append-only JSONL persistence for `SessionGraph`
- `src/session.ts`: immediate heuristic graph + async LLM graph upgrade pipeline
- `web/layout.ts`: pure collision-free layered DAG layout (`layoutGraph`, `edgePath`)
- `web/index.html`, `web/style.css`, `web/view.ts`, `web/app.ts`: dark-mode Decision & Path Graph UI, executive summary sidebar, non-destructive inspector, path filters, pan/zoom
- `test/heuristic.test.ts`, `test/labeler.test.ts`, `test/session.test.ts`, `test/server.test.ts`, `test/layout.test.ts`, `test/view.test.ts`: 64 passing tests
- `README.md`: updated description for Decision & Path Graph and heuristic-first behavior

## NEXT SESSION
- Optional: configure an LLM endpoint in `~/.config/intent-prompt-graph/config.json` (`labeler.baseUrl`, `labeler.model`, `labeler.apiKeyEnv`) to upgrade graphs from heuristic mode to LLM-extracted decision graphs.

## REFERENCES
- Plan: `docs/plans/immediate/20261122_1800_decision_path_graph.md`
- Approved prototype: `/home/ukd/.gemini/antigravity/brain/7d9a9283-5179-4f65-90a3-97395b4193f4/scratch/decision-graph-prototype.html`
