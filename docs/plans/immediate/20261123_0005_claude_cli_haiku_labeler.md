# Plan: Claude CLI Haiku Labeler Backend

**Status**: COMPLETE
**Created**: 2026-11-23
**Mapped Memory**: `docs/memory/20261123_0005_claude_cli_haiku_labeler.md`

## Thought Process & Context
After shipping the Decision & Path Graph overhaul, inspecting real OMP sessions (`01a20417`, `01a202af`, `01a201fa`) showed that heuristic mode hits a hard ceiling: verbatim first-sentence titles (e.g. `"You're right."`, `"Not quite."`, raw file paths), inverted `rejected` vs `decision` attribution on owner proposals, and noisy repeated blocker updates in long orchestration sessions.

The user wants to enable Claude Haiku (Claude Haiku 4.5, `--model haiku`) via their existing authenticated Claude CLI (`claude -p`) so it runs under their Claude subscription with zero per-token API billing.

Verification before coding confirmed:
- `/home/ukd/.local/bin/claude` (Claude Code 2.1.321) is installed and authenticated.
- `claude -p --model haiku --no-session-persistence --tools "" --system-prompt ... --output-format text` reads input from stdin, writes pure response text to `stdout`, routes warnings to `stderr`, skips writing junk sessions to `~/.claude/`, disables all tools, and completes in ~4.5s.
- Currently `src/labeler.ts` only supports OpenAI-compatible HTTP `/chat/completions`, and `src/session.ts` only checks `baseUrl && model` to enable LLM extraction.
- `src/session.ts` also strips `badge`/`desc`/`rationale` from `existingGraph` when sending subsequent batches, which would force the LLM to re-invent earlier rationales on multi-batch sessions.

## Phases

### Phase 1: Config, Claude CLI Labeler Backend & Incremental Context
**Status**: DONE
**Why**: `ipg` needs a clean, zero-dependency provider switch so users can use either OpenAI-compatible HTTP endpoints or the local `claude` CLI without polluting `~/.claude/` session history or breaking I5 privacy redaction.
- Add `LabelerProvider` (`"openai" | "claude-cli"`), optional `command` field, and `isLabelerConfigured()` helper to `src/config.ts`.
- Add `extractViaClaudeCli()` to `src/labeler.ts` using `Bun.spawn` with `-p --model <model> --no-session-persistence --tools "" --system-prompt <SYSTEM_PROMPT> --output-format text`, stdin piping, timeout kill, and clean stderr error reporting.
- Harden `parseGraphOutput()` to extract the outermost JSON object if a model emits preamble/postamble text around JSON, and bump HTTP `max_tokens` to 4096.
- Tighten `SYSTEM_PROMPT` to explicitly instruct returning the complete merged graph when `existingGraph` is present and keeping output raw JSON only.
- Update `src/session.ts` to use `isLabelerConfigured()` and pass full node metadata (`badge`, `desc`, `rationaleLabel`, `rationale`, `rounds`) in `existingGraph`.

### Phase 2: Unit Tests & Typecheck
**Status**: DONE
**Why**: Verify config parsing, CLI subprocess execution (stdin payload, stdout parsing, non-zero exit error handling, timeout), JSON fence/preamble extraction, and session pipeline wiring without relying on live network calls in unit tests.
- Add tests in `test/labeler.test.ts` using a tiny deterministic bun/sh fake CLI command to test `provider: "claude-cli"` end-to-end (success, I5 redacted stdin payload, non-zero exit error, preamble JSON extraction).
- Add test in `test/session.test.ts` verifying `provider: "claude-cli"` enables LLM extraction without `baseUrl`.
- Run `bun test && bunx tsc --noEmit`.

### Phase 3: Live Config, Daemon Restart & Real OMP E2E
**Status**: DONE
**Why**: Confirm Claude Haiku 4.5 via `claude -p` produces high-signal Decision & Path Graphs on real OMP sessions and streams them over live SSE from `ipg serve`.
- Write `~/.config/intent-prompt-graph/config.json` with `provider: "claude-cli"`, `model: "haiku"`, `command: "/home/ukd/.local/bin/claude"`.
- Restart `ipg serve` on `http://127.0.0.1:4761`.
- Hit live SSE for real OMP session `01a20417-4c90-7660-8277-d549fb426160` and verify `mode: "llm"`, clean synthesized node titles/rationales, and persisted graph store.

## Verification Results
- `bun test && bunx tsc --noEmit`: **68 pass, 0 fail**, exit 0.
- Live E2E against `http://127.0.0.1:4761/api/s/omp/01a20417-4c90-7660-8277-d549fb426160/events`:
  - Immediate heuristic snapshot (20 nodes, 27 turns, 0 errors).
  - Batch 1 `graph` event (`mode: "llm"`, 14 nodes, 13 edges) → Batch 2 `graph` event (`mode: "llm"`, 19 nodes, 18 edges) synthesized by Claude Haiku 4.5 via `claude -p`, persisted to store.
