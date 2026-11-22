# intent-prompt-graph: phases

Companion to the plan `docs/plans/20261122_1229_ipg_intent_prompt_graph.md`. Model, invariants and decisions: `docs/design.md`. Each phase lists the files it may add or change; the plan's Forbidden section applies to all of them. Global test rule: every test sets `PI_CODING_AGENT_DIR`, `XDG_STATE_HOME` and `XDG_CONFIG_HOME` to temp dirs and never reads or writes `~/.omp`, `~/.config` or `~/.local/state`. Verify scripts live in `scripts/`; Main runs the two that read `~/.omp` (P1, P3).

## P1 — Scaffold, core model, JSONL tailer, harness interface, OMP adapter, `ipg turns`
- Files: `package.json` (name `intent-prompt-graph`, `bin: {"ipg": "src/cli.ts"}`, scripts `test`/`typecheck`), `tsconfig.json` (strict, `noEmit`, DOM + Bun types), `bun.lock`, `.gitignore` (`node_modules/`), `src/model.ts`, `src/tail.ts`, `src/config.ts` (the one loader for `${XDG_CONFIG_HOME:-~/.config}/intent-prompt-graph/config.json`; P1 reads `harnessText`, P2 adds the `labeler.*` keys, P3 adds `port` and `idleExitMinutes`), `src/harness/harness.ts`, `src/harness/omp.ts`, `src/cli.ts` (first line `#!/usr/bin/env bun`, committed with mode 100755 so `bun link` works; only the `turns` subcommand for now), `test/fixtures/omp/agent/sessions/-proj/2026-11-22T10-00-00-000Z_0000aaaa-0000-7000-8000-000000000001.jsonl`, `test/omp.test.ts`, `test/tail.test.ts`, `scripts/verify-p1.sh` (the verify below as a script: it needs `pipefail`, `timeout` and timing, which a plan line cannot express cleanly). The breadcrumb fixture is not committed; the test creates it at runtime.
- `src/model.ts` holds the shared types and the SSE protocol: `Author = "owner"|"agent"`; `Turn {id, author, at (ms), text, actions: {tool, summary}[], openedBy?: string, trigger?: {from:"owner", text: string (≤400)} | {from:"agent", type: string}, guest?: true, open: boolean}` (`guest` marks a `collab-prompt` turn; its text is never sent to the labeler); `Kind = "asked"|"found"|"did"|"approved"|"advises"`; `Intent {id, title, createdAt}`; `Label {turnId, intentId, kind, caption}`; `ServerEvent = {type:"snapshot", session, turns, intents, labels, labelerError?} | {type:"turn", turn} | {type:"intent", intent} | {type:"label", label} | {type:"labeler", error?: string} | {type:"reset"}`.
- `src/harness/harness.ts`: `interface Harness { id; locate({cwd, tty?, sessionFile?}): Promise<SessionRef>; resolve(key): Promise<SessionRef>; reader(ref, {harnessText: RegExp[]}): { push(record: unknown): Turn[] } }`, `SessionRef {harness, key, file, cwd, title?}`, and `export const harnesses = { omp }`. It is the only importer of `omp.ts` (I3).
- `src/tail.ts` (generic, reused by future adapters, because all three target harnesses write JSONL): it reads from byte offset 0, splits complete lines only, buffers a partial last line, then follows with `fs.watch` plus a 1 s stat poll as a safety net. If the inode changes or the size shrinks it emits `reset` and re-reads from 0. Bad JSON lines are skipped and the tail continues. No whole-file reads: stream the file (sessions reach 142.9 MB).
- `src/harness/omp.ts`:
  - (a) Agent dir is `$PI_CODING_AGENT_DIR` or `~/.omp/agent`.
  - (b) `locate`: `sessionFile` if given. Else the breadcrumb `terminal-sessions/<tty minus "/dev/", "/"→"-">` (observed `pts-7`; line 1 is cwd, line 2 is the session file; session.md:61). Else the newest `sessions/*/*.jsonl` whose `type:"session"` header `cwd` equals cwd (read the first 4 KiB only). Otherwise throw an error that names every place it looked.
  - (c) `resolve(key)`: glob `sessions/*/*_<key>.jsonl`. The key is the header `id`.
  - (d) Reader rules:
    - `title` and `session` lines are skipped.
    - `message` with role `user` → owner turn. If its text matches a `harnessText` regex, it becomes a pending trigger instead, but only while no agent turn is open; a mid-turn match is ignored, as `async-result` is (below). Text blocks are joined; image blocks become `[image]`.
    - `custom_message` with `display:true` and `attribution:"user"` (`collab-prompt`, the only such type in the census) → owner turn with `guest: true` (design.md, Decisions added during the rewrite).
    - `custom_message` with `display:true` and `attribution:"agent"` (`async-result`, `irc:incoming`, …) → pending trigger, but only if no agent turn is open. Otherwise it is ignored.
    - A pending trigger lives only until an owner turn opens (which clears it) or the next assistant message consumes it as `trigger`. It is never carried into a later turn.
    - `custom_message` with `display:false`, role `developer`, `custom`, `model_usage`, `compaction` and every other type → ignored.
    - An assistant `message` opens an agent turn if none is open. If the newest turn is an owner turn, `openedBy` is its id. Else if a pending trigger exists: `trigger` = `{from:"owner", text}` (capped at 400 chars) for a `harnessText` match, or `{from:"agent", type}` for an agent-attributed custom message (the type only; its text is never read). Else the turn has neither field: an ignored harness event woke it (for example the `display:false` `session-stop-continuation`), and P2 labels it like any unopened turn. Visible text blocks are appended (not `thinking`), and the text keeps the last 20,000 chars. Each `toolCall` becomes `{tool: name, summary: args.i ?? args.description ?? first string arg, capped at 120}`. `stopReason` in {stop, aborted, error} closes the turn.
    - `custom` with `customType:"session_exit"` closes an open agent turn.
    - Every change re-emits the whole turn (upsert by id). Turn id = id of the turn's first entry.
- Tests (fixture hand-written in the OMP shape seen in Background; no real transcript text; `PI_CODING_AGENT_DIR` set to a temp dir): title slot line; header; plain owner→agent exchange ending `stop`; a steering owner message mid-turn splits the agent turn in two, and the second part has `openedBy` = the steering message; an `async-result` while idle becomes `{from:"agent", type}` trigger of the woken agent turn, and its text is absent from the Turn; an `async-result` mid-turn does not split; a `harnessText` match mid-turn is ignored (no split, no pending); a pending trigger is cleared by an owner turn; a `display:false` `session-stop-continuation` while idle opens a turn with neither `openedBy` nor `trigger`; `display:false` messages are ignored; `collab-prompt` is an owner turn with `guest: true`; a `harnessText` match while idle becomes `{from:"owner", text}`; `loadConfig` reads `harnessText` from a temp `XDG_CONFIG_HOME`; an `aborted` turn closes; `session_exit` closes a dangling turn; the breadcrumb test creates `terminal-sessions/pts-9` at runtime (line 1 cwd, line 2 absolute path of the copied fixture) and checks `locate`; cwd fallback in `locate`. Tail tests: a partial line completes later; a non-JSON line between two valid lines is skipped and both valid lines are emitted; an atomic rename emits `reset`; truncation emits `reset`; a 256-byte title slot rewritten in place emits nothing.
- `ipg turns --harness omp --session-file <f>` prints one Turn JSON per line: one line per turn of the final state after the full replay (each turn once, after its last upsert), not one line per upsert. `harnessText` is read from the real config (read-only), for adapter debugging and for building the P6 eval set.
- Why: this fixes the harness boundary and the data contract that every later phase builds on. difficulty: 3.
- Verify: `bash scripts/verify-p1.sh /home/ukd/.omp/agent/sessions/-Work-gateforge/2026-10-06T05-15-55-164Z_01a10fa3-cb9c-7201-b91a-acfe1257b3f2.jsonl` (`<session>` is the 142.9 MB file). Script spec (`set -euo pipefail`, repo as cwd):
  0. `TMP=$(mktemp -d)`; `OUT="$TMP/turns.txt"`; `trap 'rm -rf "$TMP"' EXIT` (cleanup on any exit; step 3 writes to `$OUT`).
  1. `bun install --frozen-lockfile`; `bun test test/omp.test.ts test/tail.test.ts`; `bunx tsc --noEmit`; `! grep -rln 'harness/omp' src --include='*.ts' | grep -v '^src/harness/'`.
  2. For each of the 20 newest `$HOME/.omp/agent/sessions/*/*.jsonl` (from `ls -t … | sed -n 1,20p`; `sed`, not `head`, so pipefail cannot SIGPIPE `ls`) and the argument: `bun src/cli.ts turns --harness omp --session-file "$f" > /dev/null`.
  3. `start=$(date +%s%N)`; `timeout 3 bun src/cli.ts turns --harness omp --session-file "$1" > "$OUT"` (exit 124 fails the script). Print `wc -l < "$OUT"` and the elapsed ms; record both in Progress. A naive stream parse of this file took 0.92 s (design.md, Background evidence).

## P2 — Labeler, label store, session pipeline, fake labeler
- Files: `src/labeler.ts`, `src/store.ts`, `src/session.ts`, `test/fake-labeler.ts`, `test/labeler.test.ts`, `test/session.test.ts`. The labeler keys are read by `src/config.ts` (P1).
- `src/labeler.ts`:
  - Request: `POST {baseUrl}/chat/completions` with `{model, temperature: 0, max_tokens: 1500, response_format: {type: "json_object"}, messages: [system, user]}`, a 60 s timeout, and `Authorization: Bearer $<apiKeyEnv>` when set.
  - Input JSON in the user message: the intents (id, title, last 2 captions; at most `MAX_INTENTS_IN_PROMPT` = 40, the most recently active, so an older intent is not offered and a recurrence of it gets a new intent; P6 measures how often); the 3 turns before the batch (author, kind, caption); and the batch turns. An owner turn gives its text capped at 800 chars; a guest turn (`guest: true`) gives `[guest message withheld]`. An agent turn gives its final text block capped at 1200 chars, tool-name counts, `fixedIntent` when it inherits one, and `trigger` text only when `from:"owner"` (agent-attributed triggers carry a type only and are never sent).
  - Output: `{"turns":[{"ref","intent": "<existing id>" | {"new":"n1","title":"≤6 words"} | "n1","kind","caption"}]}`. `ref` is the batch turn's `id`; each id is answered exactly once. A new intent declared earlier in the batch can be reused by its `n` ref.
  - Validation is strict: every ref answered once; the kind is allowed for the author (owner: asked/approved; agent: found/did/advises/asked); the intent is known; `intent` is ignored for fixed-intent turns. Captions are at most 14 words (the prompt asks for it) and the code also cuts them to 120 chars. Strip a code fence before `JSON.parse`. On any violation the whole batch fails, nothing is stored, and the error is surfaced.
- `src/store.ts`: append and replay the per-session JSONL described under Decisions in `docs/design.md`.
- `src/session.ts`: one live pipeline per watched session. It drives `tail` → `reader` → turn map, then emits `turn` events at once (I1). Its single worker labels the closed, unlabeled turns in file order, in batches of ≤8 turns or ≤6,000 chars of turn text. A batch closes before any agent turn whose `openedBy` is an unlabeled turn in that batch, so the owner's label is stored before that agent turn is requested and its `fixedIntent` is known. An agent turn with `openedBy` gets `intentId` from its owner turn's label. An agent turn without `openedBy` (with or without `trigger`) is labeled like an owner turn: its own intent choice and an agent kind. Intent ids are `i1, i2, …` per session. It writes intent/label lines to the store, then emits events. On `reset` it builds a new reader, replays, and keeps the stored labels by turn id. On a labeler error it emits `{type:"labeler", error}` and retries on the next turn and every 60 s.
- Tests (the fake endpoint is a `Bun.serve` on port 0 that returns scripted JSON and records requests):
  - The recurrence case: owner Q "why did check fail?" → agent A1 → unrelated owner Q2 → agent → (1 h later in timestamps) owner Q "why did check fail?" → agent A3. The fake returns the existing intent for the repeat. Assert Q, A1, the repeat and A3 share one intentId, and Q2's differs.
  - A1's request marks `fixedIntent`.
  - Batch `n1` reuse.
  - An invalid kind for an author and an unknown intent id each store nothing and emit `labeler` error.
  - With the fake delayed 2 s, the `turn` event arrives in < 100 ms.
  - Restart on the same store → zero requests for already-labeled turns.
  - A file rewrite (rename over) → `reset`, labels kept.
  - More than 40 intents: a recurrence whose intent falls outside the 40 offered gets a new id (`MAX_INTENTS_IN_PROMPT`).
  - An agent-attributed trigger's text never appears in any request body (the fake records requests).
  - A guest turn's text never appears in any request body (the fake records requests).
  - A batch split: an owner turn and the agent turn it opens land in different requests, and the second request carries `fixedIntent`; a trigger-only agent turn gets its own intent choice.
- Labels are immutable once stored (I2). The labeler gets only the capped text and tool-name counts defined in I5.
- Why: this is the only code that turns transcript into intents; isolating it from HTTP makes the clustering rules testable. difficulty: 3.
- Verify: `set -o pipefail; cd /home/ukd/projects/intent-prompt-graph && bun test && bunx tsc --noEmit`

## P3 — Daemon and CLI: serve and open
- Files: `src/server.ts`, `src/cli.ts` (extended), `test/server.test.ts`, `web/index.html` (a placeholder page; P4 replaces it), `scripts/verify-p3.sh` (the verify below as a script: it needs polling, a trap and timing, which a plan line cannot express).
- `src/server.ts` (`Bun.serve`, hostname `127.0.0.1`):
  - `GET /s/:harness/:key` → `web/index.html` (a placeholder in P3; P4 replaces it).
  - `GET /api/s/:harness/:key/events` → SSE: a `snapshot` first, then live events. The session pipeline is shared by all clients of one session and stopped 60 s after its last client leaves.
  - `GET /health` → `{"app":"intent-prompt-graph"}`.
  - `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` (the server's own port); any other value gets 403 (I5). An unknown harness or key gets 404.
  - Idle exit after `idleExitMinutes` (config, default 15) with no SSE client.
- `src/cli.ts`:
  - Config: `loadConfig()` (`src/config.ts`, P2) supplies `port` (default 4761) and `idleExitMinutes` (default 15).
  - `ipg serve [--port N]`.
  - `ipg open [--harness omp] [--session-file F] [--no-browser] [--port N]` → `locate` (cwd; `tty` from `Bun.spawn(["tty"], {stdin: "inherit", stdout: "pipe"})`, where exit 1 means no tty, so `tty` is undefined and `locate` uses cwd; no `/proc`, so it also works on macOS), then `/health` on the port. If nothing answers, spawn `ipg serve --port N` detached (`Bun.spawn` with `stdio: ignore`, `.unref()`) and poll `/health` for ≤ 3 s. Print exactly one line, the URL `http://127.0.0.1:<port>/s/omp/<key>#latest`, then open it with `xdg-open` (Linux) or `open` (macOS) unless `--no-browser`. If a foreign process answers on the port, fail with a message that names the port and the `port` config key.
  - `ipg open` prints that URL; the `#latest` hash focuses the newest turn.
- Bind 127.0.0.1 on port 4761 by default. Reject a foreign `Host` header (I5). Live updates over server-sent events. Exit 15 minutes after the last browser disconnects.
- Tests: a temp agent dir via `PI_CODING_AGENT_DIR` holding a copy of the P1 fixture; the fake labeler from P2; `serve` on port 0. Check: the page is 200; the first SSE event is `snapshot` with the fixture turns; appending an owner line yields a `turn` event in < 1 s and later a `label`; `Host: evil.example` gets 403; an unknown key gets 404; `idleExitMinutes: 0.01` exits the process.
- Witness steps (Main runs these after the verify passes; the implementer does not): none beyond the verify and the tests above.
- Why: the browser needs one stable local origin per machine, and the slash command needs a fire-and-forget way to reach it. difficulty: 2.
- Verify: `bash scripts/verify-p3.sh /home/ukd/.omp/agent/sessions/-Work-gateforge/2026-10-06T05-15-55-164Z_01a10fa3-cb9c-7201-b91a-acfe1257b3f2.jsonl` (`<session>` is the 142.9 MB file). Script spec (`set -euo pipefail`; a `trap` kills the server and the curl and removes temp files on any exit):
  0. `TMP=$(mktemp -d)`; `export XDG_STATE_HOME="$TMP/state" XDG_CONFIG_HOME="$TMP/config"`; `OUT="$TMP/events.txt"`; `S` and `C` start empty. The trap kills `$C` and `$S` when non-empty, then runs `rm -rf "$TMP"`. The script reads `~/.omp` only through the session file.
  1. `bun test` and `bunx tsc --noEmit` in the repo.
  2. `P=$((20000 + RANDOM % 10000))`; `bun src/cli.ts serve --port "$P" & S=$!`.
  3. Poll `curl -sf http://127.0.0.1:$P/health` every 0.1 s for up to 10 s until it prints {"app":"intent-prompt-graph"}; otherwise fail.
  4. `URL=$(bun src/cli.ts open --no-browser --harness omp --session-file "$1" --port "$P")`. The output is one line, `http://127.0.0.1:<port>/s/omp/<key>#latest`; `KEY` is the segment after `/s/omp/` without `#latest`.
  5. `start=$(date +%s%N)`; `curl -sN --max-time 15 "http://127.0.0.1:$P/api/s/omp/$KEY/events" > "$OUT" & C=$!`; poll `$OUT` every 0.05 s for `"type":"snapshot"` for up to 10 s; if none appears, print `no snapshot in 10 s` and exit 1; `ms=$(( ($(date +%s%N) - start) / 1000000 ))`.
  6. Fail unless `ms` < 3000. Print `first-event ${ms} ms` and record it in Progress; then kill `$C` and `$S`.

## P4 — Browser UI; Main-witnessed DOM and screenshot check
- Files: `web/index.html`, `web/app.ts` (SSE state, selection, follow mode), `web/layout.ts` (spirals, pure functions), `web/view.ts` (DOM cards, SVG edges, pan/zoom, panels), `web/style.css`, `test/layout.test.ts`. `server.ts` imports `web/index.html` as a Bun HTML route (Bun bundles the TS and CSS; there is no build step).
- Layout follows the Model in `docs/design.md` (Layout). It is append-stable (I6). Cards are absolute-positioned divs with SVG edges. No graph library. `web/layout.ts` exports the functions and the constants `r0`, `c`, `cChip`, `GAP`, with their starting values from `docs/design.md`. The P4 layout tests are the oracle: the implementer raises any of those constants as needed, with no cap, until they pass, and records the final values in `docs/design.md` (Layout) and in Progress. The assertions, the n and j ranges, the card and chip sizes, and the overlap definition are fixed; no test is weakened or skipped.
- Look, taken from the reference image:
  - Dark background with a dot grid.
  - Cards are about 220 px wide, with a header line `YOU ASKED · 3m ago` / `AGENT DID · 1h ago` in the kind colour (asked pink, found teal, did green, approved lime, advises amber) and a 2–3 line caption.
  - The focused intent hub is a larger card in the centre: title, turn count, last activity.
  - Curved edges run from hub to turn in the kind colour.
  - The other intents are chips on the outer spiral (title, count, coloured dots for kinds), plus a "Sorting…" chip for unlabeled turns.
  - Left sidebar: the intent list sorted by last activity. Right panel: the selected turn (full text, `white-space: pre-wrap`, actions list for agent turns, absolute and relative time) and below it the intent's thread (all its turns in time order, each clickable).
  - Bottom bar: Follow latest toggle, Fit, Reset zoom.
  - Class names (the witness check uses them): the focused intent hub is `.hub`, with `.focus` on the focused one; turn cards are `.card`, with `.latest` on the newest turn only and one kind class per kind (`.kind-asked`, `.kind-found`, `.kind-did`, `.kind-approved`, `.kind-advises`); chips are `.chip`.
- Behaviour:
  - Opening the page focuses the intent of the latest turn, selects that turn, and gives it a glowing ring (`.latest`).
  - An open agent turn has a dashed border and shows its last action summary live.
  - New turn while Follow is on: refocus on its intent and move `.latest`. With Follow off (it switches off when the owner clicks anything), a "New turn in <intent> — jump" toast appears instead.
  - Fade by recency rank as in the model. Hover restores full opacity.
  - Clicking a chip or sidebar entry focuses that intent, with an animated transform.
  - Wheel zooms and drag pans.
  - URL hash `#turn=<id>` restores the selection.
  - A banner shows the labeler error.
  - EventSource reconnects. On `snapshot` or `reset` the state is rebuilt.
- Layout tests:
  - The tests compute positions with the exported functions in `web/layout.ts` and hard-code no constants of their own, except the sizes and ranges below. Two axis-aligned rectangles centred at p1 and p2, with sizes w1×h1 and w2×h2, overlap iff |dx| < (w1+w2)/2 and |dy| < (h1+h2)/2.
  - For n = 1..200 turns of the focused intent: no two card rectangles (220×90) overlap.
  - Positions of turns 1..n are unchanged when turn n+1 is added (I6).
  - For n = 1..200 and chip ordinals j = 1..40: no two chip rectangles (200×48) overlap, and the nearest point of every chip rectangle to the hub centre is at least Rcl(n) away.
- Main-witnessed check (Main runs it; the implementer must not mark P4 done without it): Main serves the P1 fixture through a temp agent dir with the fake labeler, opens the page with the eval `browser` global, and asserts in the DOM: exactly one `.hub.focus`; exactly one `.card.latest`, and it is the newest turn; every labeled `.card` has exactly one kind class (`.kind-asked`, `.kind-found`, `.kind-did`, `.kind-approved` or `.kind-advises`); computed opacity is non-increasing with age. Then Main appends one owner line to the fixture copy: a new card appears and takes `.latest` within 1 s. Main screenshots the page next to `docs/reference-image.png` and attaches both paths to Progress.
- Why: this is the owner-facing product; the reference image fixes the visual language. difficulty: 4.
- Verify: `set -o pipefail; cd /home/ukd/projects/intent-prompt-graph && bun test && bunx tsc --noEmit`

## P5 — OMP `/graph` slash command and README
- Files: `integrations/omp/intent-graph.ts`, `integrations/omp/types.d.ts` (local minimal declarations of the OMP types the extension uses: `ExtensionAPI.registerCommand`, `ExtensionCommandContext` with `ui.notify` and `sessionManager.getSessionFile`; the repo cannot import OMP's `src`), `tsconfig.json` (add `integrations/omp` to `include`), `README.md`.
- Default export: `export default function (pi: ExtensionAPI)`, the shape of `ExtensionFactory` (`types.ts:1592`); the implementer confirms it there when writing `types.d.ts`.
- The extension calls `pi.registerCommand("graph", {description: "Open the intent graph of this session in the browser", handler})` (`types.ts:1349`). The handler reads `ctx.sessionManager.getSessionFile()` (`session-manager.ts:1950`). If it is missing, it shows `ctx.ui.notify("This session is not saved to disk", "warning")`. Otherwise it runs `ipg open --harness omp --session-file <file>` with `node:child_process` `execFile` (PATH `ipg`, installed by `bun link`) and notifies the printed URL. The subagent guard from the original text (`ctx.agent.kind === "sub"`) is dropped: see `docs/design.md`, "Decisions added during the rewrite".
- README: what it is, `bun link`, the symlink line, the config example, how to pick a labeler endpoint, and the privacy note (I5).
- Why: the owner's main entry point is a slash command inside OMP. difficulty: 1.
- Verify: `set -o pipefail; cd /home/ukd/projects/intent-prompt-graph && bunx tsc --noEmit && grep -q 'registerCommand("graph"' integrations/omp/intent-graph.ts`
- Main steps (after verify, Main runs them, not the implementer): `cd /home/ukd/projects/intent-prompt-graph && bun link && ln -s /home/ukd/projects/intent-prompt-graph/integrations/omp/intent-graph.ts /home/ukd/.omp/agent/extensions/intent-graph.ts`, starts an OMP TUI session in tmux, sends two prompts, types `/graph`, and confirms that the notified URL contains that session's id and that the page shows both owner turns, with the second one `.latest`.

## P6 — Labeler evaluation and default model (needs an endpoint from the owner; see the plan's WAITING line)
- Files: `eval/cases/<case>.jsonl` (reduced turns, one JSON object per line), `eval/cases/<case>.gold.json` (gold labels keyed by turn id), `eval/run.ts`, `docs/labeler-eval.md`.
- Steps:
  1. Main picks 3 real OMP sessions: one with ≥30 owner turns, one with steering, and one where a question repeats. Main exports them with `ipg turns` into a temp directory outside the repo. The raw export holds full guest text, so it is never written into the repo or committed.
  2. Main reduces each turn to the labeler's input under I5 and P2 and writes it as one line of `eval/cases/<case>.jsonl`: owner text ≤800 chars; owner-origin trigger text ≤400 chars, agent-attributed trigger as type only; agent final text ≤1200 chars; tool calls as tool names only; no tool output. A guest turn keeps `guest: true` and its text becomes exactly `[guest message withheld]`. Main removes secrets (verify grep below), then hand-labels a gold intent and kind for every turn in `eval/cases/<case>.gold.json`. A guest turn's gold comes only from the owner and agent turns around it, never from its withheld text; it is scored like any other turn.
  3. The cases with gold labels are committed **before** the first model run (no peeking).
  4. `eval/run.ts` replays each case's turns through the P2 labeler path in `src/session.ts`, so the batching and input rules are the code's, not run.ts's. It reports pairwise same-intent F1 over turn pairs, kind accuracy, the recurrence case pass/fail, calls, latency p50/p95, and tokens if the endpoint returns usage. `docs/labeler-eval.md` records the guest-turn count per case.
- Pass bar: pairwise F1 ≥ 0.80, kind accuracy ≥ 0.80, recurrence case passes.
- Run every candidate model the owner makes available, and pick the cheapest one that passes as the README default. Record all numbers in `docs/labeler-eval.md`. If none passes, stop and report the numbers; do not tune the prompt against the gold labels more than 3 rounds, and record each round.
- Why: the clustering quality is a claim that only measurement can back, and the model choice depends on it. difficulty: 3.
- Verify: `set -o pipefail; cd /home/ukd/projects/intent-prompt-graph && ! grep -rEn '(sk-[A-Za-z0-9]{20,}|glpat-|ghp_[A-Za-z0-9]{20,}|xox[bp]-|AKIA[0-9A-Z]{16}|-----BEGIN)' eval/ && ! grep -hE '"guest": ?true' eval/cases/*.jsonl | grep -vF '"text":"[guest message withheld]"' > /dev/null && bun eval/run.ts | tee /tmp/ipg-eval.txt && grep -q 'PASS' /tmp/ipg-eval.txt`
