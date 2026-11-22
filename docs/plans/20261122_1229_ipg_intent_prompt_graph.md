# intent-prompt-graph: live browser graph of a coding-agent conversation, grouped by intent

Repo: /home/ukd/projects/intent-prompt-graph (git init done, no commits, no remote)
Branch: master
Summary: Local `ipg` reads one harness session (OMP first), cuts it into turns, sorts each turn into an intent with a small LLM, and shows a live node graph in the browser. `/graph` in OMP opens it at the current conversation.
Queue: personal
Planner: IpgPlannerRepair
Read /home/ukd/projects/opus-implementer-method.md first.
Plan file: /home/ukd/projects/intent-prompt-graph/docs/plans/20261122_1229_ipg_intent_prompt_graph.md
Reference image: /home/ukd/projects/intent-prompt-graph/docs/reference-image.png

## Goal
- `/graph` in OMP, or `ipg open` in a shell, opens the browser at the current conversation: the latest intent at the centre, its turns around it, other intents as chips on an outer spiral, the latest turn highlighted.
- Grouping is by intent, not time: a question asked again later joins the same intent.
- A new turn appears within 1 s. Its intent follows when the labeler answers.
- OMP is the only adapter now. Model, invariants, decisions: docs/design.md. Phase files and steps: docs/phases.md.

## Forbidden
- Never write harness files (`~/.omp/agent/sessions/**`, `~/.claude/**`, `~/.codex/**`). Main makes the P5 extension symlink.
- No import from neurastream. No runtime npm dependencies; dev dependencies are `typescript` and `@types/bun` only. Any other package needs Main's approval.
- Every new file, function, option or dependency needs a one-sentence commit-message reason why existing code cannot do it. No sentence means don't add it. Dead code is removed.
- Never `git add -A` or `git add .`; add files by name. No skipped tests, no `.only`, no weakened assertions, no retries as fixes.
- Never send tool outputs, agent-attributed trigger text or guest-message text to the labeler (I5). It gets owner-role text, the agent's final text and tool-name counts, nothing else.
- Owner rule: never push to any remote (none exists).
- Per phase, stop and report within ~100 calls; long agents reread huge contexts.

## Blockers
- no-push
- deny-path /home/ukd/.omp/** /home/ukd/.claude/** /home/ukd/.codex/** /home/ukd/projects/neurastream/**
- deny-command git\s+push\b --no-verify git\s+add\s+(-A|--all|\.)(\s|$) reset\s+--hard clean\s+-[a-z]*f

## Phases
- [ ] P1 Scaffold, model, tailer, harness boundary, OMP adapter, `ipg turns` — verify: `bash scripts/verify-p1.sh /home/ukd/.omp/agent/sessions/-Work-gateforge/2026-10-06T05-15-55-164Z_01a10fa3-cb9c-7201-b91a-acfe1257b3f2.jsonl`
- [ ] P2 Labeler, label store, session pipeline, fake labeler — verify: `set -o pipefail; cd /home/ukd/projects/intent-prompt-graph && bun test && bunx tsc --noEmit`
- [ ] P3 Daemon and CLI: serve and open — verify: `bash scripts/verify-p3.sh /home/ukd/.omp/agent/sessions/-Work-gateforge/2026-10-06T05-15-55-164Z_01a10fa3-cb9c-7201-b91a-acfe1257b3f2.jsonl`
- [ ] P4 Browser UI; Main-witnessed DOM and screenshot check — verify: `set -o pipefail; cd /home/ukd/projects/intent-prompt-graph && bun test && bunx tsc --noEmit`
- [ ] P5 OMP `/graph` command and README — verify: `set -o pipefail; cd /home/ukd/projects/intent-prompt-graph && bunx tsc --noEmit && grep -q 'registerCommand("graph"' integrations/omp/intent-graph.ts`
Order: P1 → P2 → P3 → P4 → P5. Per-phase files and steps: docs/phases.md.

## Done check
`set -o pipefail; cd /home/ukd/projects/intent-prompt-graph && test -z "$(git status --porcelain -- src web test integrations scripts README.md package.json)" && bun test && bunx tsc --noEmit && ! grep -rln 'harness/omp' src web --include='*.ts' | grep -v '^src/harness/' && test -L /home/ukd/.omp/agent/extensions/intent-graph.ts`, plus the Main-witnessed P4 and P5 checks recorded in Progress.

## Applies to
- New repo only, plus one Main-made symlink in ~/.omp/agent/extensions/ (P5).

## Background
- Evidence, measurements, the rejected `omp -p` labeler, the local-LLM check and the config keys: docs/design.md (Background evidence, Design decisions).

## Code read by Main
- neurastream `src/core/queue/lib.ts`, `src/core/waiting-check.ts`; OMP `src/extensibility/extensions/types.ts`, `src/session/session-manager.ts` (read); other OMP `src` files and `herdr-omp-agent-state.ts` (grep, cited lines only).
- `/home/ukd/.omp/agent/queue/TEMPLATE.md`, `/home/ukd/.omp/agent/terminal-sessions/pts-7` (read).

## Reuse
- `registerCommand(name, {description, handler})` on `ExtensionAPI` — checked: /home/ukd/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts:1349
- `ExtensionCommandContext` gives `ctx.ui` and `ctx.sessionManager` — checked: /home/ukd/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts:550
- `ctx.ui.notify(message, type)` — checked: /home/ukd/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts:279
- `ctx.sessionManager.getSessionFile()` — checked: /home/ukd/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts:1950
- Extensions in `extensions/*.ts` are auto-discovered — checked: /home/ukd/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/discovery/builtin.ts:587
- Session title slot is 256 bytes — checked: /home/ukd/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/session/session-entries.ts:8
- Full rewrites are atomic — checked: /home/ukd/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/session/session-manager.ts:743
- Breadcrumb line 2 names the session file (`/home/ukd/.omp/agent/terminal-sessions/pts-7`) — checked: /home/ukd/.omp/agent/terminal-sessions/pts-7:2
- An OMP user extension imports `node:` built-ins — checked: /home/ukd/.omp/agent/extensions/herdr-omp-agent-state.ts:8

## Progress
Status: open
- 2026-11-22 12:38 IpgPlanner: plan written. Evidence gathered: OMP session schema survey (300 sessions), parse timing on the largest session, `omp -p` labeler probe (rejected), local LLM availability, OMP extension and session docs. Not indexed in `/home/ukd/.omp/agent/INDEX.md` (Main's queue).
- 2026-11-22 13:25 Main: P6 split to docs/plans/20261122_1315_ipg_labeler_eval.md (waits on this plan); the WAITING line moved there. This plan is runnable: next the reviewer.
- 2026-11-22 13:13 Main: plan reshaped by IpgPlannerFixHaiku to pass queue-check (brief 8099 bytes, design in docs/design.md, steps in docs/phases.md); WAITING line restored to checker form by Main. Verify commands in P1/P3 read ~/.omp session files, which the implementer's deny-path blocker forbids: Main runs those verifies, not the implementer. Next: reviewer.
- 2026-11-22 13:22 IpgReviewer: verdict FAIL. Scope: whole plan, read with docs/design.md and docs/phases.md. Checked OK: phase order P1→P5 is dependency-consistent; blockers match Forbidden and the Done check; config keys and the 15-minute idle exit match across plan, design and P3; P1 verify pipeline is correct under pipefail. Reuse citations checked against OMP src: types.ts:279, :550, :1349; session-manager.ts:743, :1950, :1099, :2319; session-entries.ts:8, :264-266; session-title-slot.ts:115-118; exit-diagnostics.ts:6; agent-session.ts:1027, :7785; irc-bridge.ts:23; builtin.ts:58, :483, :587; loader.ts:564; herdr-omp-agent-state.ts:8; breadcrumb pts-7:2. Session header id equals the filename suffix, so resolve(key) holds. Not verified: types.ts:256, :1178, :471, :477; session-manager.ts:359, :364; agent-session.ts:1470, :2430.
  Defects to fix before implementers start:
  1. P3 verify (phases.md:66) cannot pass under pipefail. `timeout 10 curl -sN ... | head -c 200 | grep -q` exits non-zero when curl is killed (124) or gets SIGPIPE, even when grep matched.
  2. P3 verify uses `open --port $P` (phases.md:66); the P3 spec (phases.md:60) lists no `--port`. The URL format is also unspecified, yet the verify parses `/s/omp/<key>`.
  3. P3 verify timing is wrong: `/usr/bin/time -f 'first-event %e s' timeout 10 curl ...` measures the whole curl run (up to 10 s), not time to first event. The <3 s bound (phases.md:63) is never asserted.
  4. P3 verify leaks a serve process per run (`(bun src/cli.ts serve ... &)` is never killed). Readiness is `sleep 1`.
  5. P1 verify (phases.md:26): the <3 s budget for the 142.9 MB parse is prose only. Enforce it, e.g. `timeout 3`.
  6. Privacy conflict: P2 input includes `trigger` (phases.md:32; text capped at 400 chars, phases.md:20). design.md I5 (:21) and the plan Forbidden line (plan:23) allow only owner text, agent final text and tool-name counts. `async-result` and `irc:incoming` trigger text can carry job or tool output. Send only a trigger type, or amend I5 and Forbidden explicitly.
  7. File lists are incomplete. P3 needs a placeholder `web/index.html` (phases.md:63 vs P4 :69, which lists it as P4-created). Config loading (phases.md:58) has no file; P2 needs `labeler.baseUrl`, so name the module.
  8. P5 `integrations/omp/intent-graph.ts` cannot be typechecked as specified. It needs `ExtensionAPI`/`ExtensionCommandContext` types, but only `typescript` and `@types/bun` are allowed (plan:20). Say how the types are obtained: an absolute `import type` from the OMP install, or local structural types.
  9. P1 `bin` (phases.md:6) needs a `#!/usr/bin/env bun` shebang and an executable bit. P5 `bun link` depends on both.
  10. P4 layout constants are unspecified (phases.md:70): spiral r0, c, hub size. State that the implementer picks values that pass the no-overlap test.
  11. P3 Host rule (phases.md:55, :62) says only "foreign". design.md I5 (:21) allows `127.0.0.1:<port>` or `localhost:<port>`. Write the allowed set into P3.
  12. P1 breadcrumb fixture (phases.md:6): `pts-9` line 2 must name a session file, and an absolute path is not portable. Say the test rewrites it at runtime from the temp dir.
  13. Tests must isolate `XDG_STATE_HOME` and `XDG_CONFIG_HOME` (store and config default under `~`). P2 and P3 do not say so.
  14. P2 batch `ref` (phases.md:33) is undefined (turn id? index?). The intents list has no cap, so long sessions grow the prompt without bound.
  15. Unsupported design claim: "less than half of all turns" (design.md:9) has no measurement. Also state whether `main-guard.queue` and `session-stop-continuation` are display true or false (design.md:54). An agent turn woken by an ignored message has no `openedBy` or `trigger` and no rule in P1.
  16. Reuse line 63 cites plan:1 for "No repo code exists yet". That does not support the claim. The claim is true (the glob shows only docs/); cite that or drop the line.
  17. Nit: design.md cites types.ts:1363 as registerShortcut. The declaration starts at :1359; :1363 is the handler.
  18. Caption limits: design.md says ≤14 words; P2 says 120 chars (phases.md:34). State that both apply, or pick one.
  19. P3 `tty` from `/proc/self/fd/0` (phases.md:60) is Linux-only, but design says macOS is supported. State the fallback.
  Accepted, not defects: `~/.omp` reads in P1/P3 verifies (Main runs them); P4/P5 verifies are tsc and grep only, covered by Main's witness; P6 lives in 20261122_1315_ipg_labeler_eval.md.
  Main: fix items 1-7 and 8-14 in the plan and phases.md, then re-review. Status stays open.
  Findings: P3 verify pipefail (phases.md:66); P3 timing measures whole curl run (phases.md:66); `open --port` not in spec (phases.md:60,66); serve process leak (phases.md:66); P1 timing prose-only (phases.md:26); trigger in labeler input conflicts with I5 (phases.md:32, design.md:21, plan:23); file-list gaps (phases.md:58,63,69); P5 types unspecified (phases.md:97-102, plan:20); bin lacks shebang and exec bit (phases.md:6); P4 layout constants undefined (phases.md:70); P3 Host allowed set unstated (phases.md:55,62, design.md:21); breadcrumb fixture path not portable (phases.md:6); XDG isolation missing (design.md:31-32); labeler ref undefined and intents uncapped (phases.md:32-33); unmeasured "less than half" claim (design.md:9); display status of main-guard.queue/session-stop-continuation unstated (design.md:54); Reuse cite plan:63 does not support claim; types.ts:1363 nit; caption limit conflict (design.md, phases.md:34); tty Linux-only (phases.md:60)
- 2026-11-22 13:35 Main: IpgPlannerRepair fixed defects 1-19 of the 13:22 FAIL (plan, docs/phases.md, docs/design.md; header Planner now IpgPlannerRepair; verifies P1/P3 moved to scripts/verify-p1.sh and scripts/verify-p3.sh). brief-lint exit 0. Next: fresh reviewer re-review of the current text.
- [stamp unrecorded: review shell is locked to redirects, Main to stamp] IpgReviewer2: verdict FAIL, second pass, scope whole plan read with docs/design.md and docs/phases.md. Read-only; no code run.
  Prior 19 defects of the 13:22 FAIL: all 19 closed in the current text. Spot checks: verify-p3 spec now polls /health, times to the snapshot, traps kill and cleanup (phases.md:73-77); P1 3 s budget is `timeout 3` (phases.md:29); Host set is exact (phases.md:60, design.md:21); bin shebang and 100755 (phases.md:6); P5 types.d.ts (phases.md:109); P4 constants left to implementer (phases.md:81); labeler ref and 40-intent cap (phases.md:35); XDG isolation (phases.md:3, design.md:31-32); caption rule both apply (phases.md:37, design.md:26); tty fallback (phases.md:65); design.md:9 and :54 fixed; registerShortcut cites :1359/:1363 (design.md:73); the "No repo code" reuse line is gone.
  New defects:
  N1 plan:23 says "owner-role text only", but I5 (design.md:21) and P2 (phases.md:35) send the agent's final text and tool-name counts. Reword to the I5 list.
  N2 P1 has no harnessText source. config.ts is P2 (phases.md:32), but the P1 reader (phases.md:16, 20), the P1 tests (phases.md:23) and `ipg turns` (phases.md:24, also P6 exports) all need harnessText. Move config.ts to P1, or define a P1 flag.
  N3 Pending-trigger lifetime is undefined (phases.md:16, 18, 20). A harnessText owner message mid-turn becomes pending while the open turn continues, and nothing clears it at turn close or when an owner turn opens. A later turn woken by an ignored event (session-stop-continuation) can then take it as `trigger`. async-result is ignored mid-turn but harnessText is not. Specify: mid-turn harnessText is ignored like async-result, and pending is cleared by the next assistant message.
  N4 P2 batch ordering (phases.md:35, 39). When an agent turn with openedBy sits in the same batch as its owner turn, `fixedIntent` is unknown at request time. Also, an agent turn with trigger but no openedBy has no P2 rule; only the "neither" case is defined. Specify: cut the batch before any agent turn whose openedBy is in it, and label trigger-only agent turns like owner turns.
  N5 Verify scripts do not isolate state. The global test rule (phases.md:3) covers tests only, but verify-p3 (phases.md:73-77) runs serve against the real XDG config and state. The session pipeline then writes labels to the real ${XDG_STATE_HOME} and calls the real labeler from ~/.config. Set XDG_STATE_HOME and XDG_CONFIG_HOME to a mktemp dir in verify-p3.sh.
  N6 Layout (phases.md:81, 100-103). The chip rule "never overlap the focus cluster's bounding circle" gives no n range, but the cluster radius grows with sqrt(n). A spiral with 220x90 cards needs area pi*c^2 per turn of at least about 19,800 px^2, so c is roughly 80-100 px [INFERENCE from card size], and the cluster reaches about 1.3k px at n=200. A constant ring radius must clear that. State the n range of the chip test and the ring radius rule.
  N7 verify-p3 (phases.md:73-77): `$OUT`, `$C` and `$S` are used but never defined. Say explicitly that no snapshot within 10 s fails the script. The trap should use `${S:-}` and `${C:-}` so a step 1 failure does not trip `set -u` inside the trap.
  N8 Minor: "bad JSON lines counted and skipped" (phases.md:9) has no test in the tail list (phases.md:23). Add the test or drop the claim.
  N9 Minor: P5 (phases.md:109-110) does not state the default export shape. Say `export default function (pi: ExtensionAPI)`, matching ExtensionFactory (types.ts:1592), and let the implementer confirm it.
  Not defects: ~/.omp reads in P1/P3 verifies (accepted). The Done check `test -L ~/.omp/...` (plan:41) is the same class, Main runs it. Code keep: the Harness interface with one-entry `harnesses` is the I3 seam, so it stays; no other new abstraction found.
  Unverified: collab-prompt (283 records, attribution "user", phases.md:17) is treated as owner text with no content sample. If it can carry peer-agent output, I5 is broken. Main to check one sample.
  Findings: N1 plan:23; N2 phases.md:16,23,24,32; N3 phases.md:16,18,20; N4 phases.md:35,39; N5 phases.md:3,73-77; N6 phases.md:81,100-103; N7 phases.md:73-77; N8 phases.md:9,23; N9 phases.md:109-110. 19/19 prior defects closed.
- 2026-11-22 13:40 Main: second review (IpgReviewer2) FAIL with new defects N1-N9; the 19 earlier ones are closed. Next: IpgPlannerRepair fixes N1-N9 and samples collab-prompt for I5, then a fresh review.
- stamp unrecorded IpgReviewer3: verdict FAIL, third pass, scope whole plan, read with docs/design.md and docs/phases.md. Read-only; no code run (review shell locked to an allowlist, so the layout numbers below are hand-computed).
  N1-N9: all closed (plan:23; phases.md:6, 16-21, 23, 24, 35-40, 75-80, 114).
  Collab-prompt/guest decision (design.md:21, :40): consistent across design, plan and phases (guest:true, "[guest message withheld]", P2 test). I5 holds whatever the collab-prompt text says, so the content sample is no longer needed.
  Blocking B1: the layout constants fail the P4 no-overlap test (phases.md:85, :105-107; design.md:12). Hand check at r0=300, c=100, i*137.508 deg: turn 76 centre ~(1152,216), turn 110 ~(1342,138); |dx| ~190 < 220 and |dy| ~78 < 90, so two 220x90 cards overlap at n=110. The density rule pi*c^2 >= 1.5 x area is a heuristic, not a guarantee; the chip constants (cChip=90, 200x48, GAP=110) are unchecked. The fallback "may raise one constant" names neither the constant nor the amount, and one raise may not be enough. Fix before implementers start: Main computes c, cChip and GAP numerically over n=1..200 and j=1..40 and writes the passing values into design.md and phases.md; or the phase says the implementer raises them as needed, with no cap, and records each value in Progress.
  Blocking B2: the P4 witness check (phases.md:108) asserts `.hub.focus` and "a kind class", but P4 names no classes (phases.md:85-93). Name them in P4: hub `.hub` with `.focus`; cards `.card` with `.latest` and one kind class per kind.
  Nits (not blocking): phases.md:25 should say `ipg turns` prints one line per turn of the final state after the full replay, not one line per upsert (this matters for the 3 s budget). phases.md:28-30: scripts/verify-p1.sh uses `$OUT` without defining it or a trap, as verify-p3 does.
  Findings: B1 design.md:12, phases.md:85, phases.md:105-107; B2 phases.md:85-93, phases.md:108; nits phases.md:25, phases.md:28-30. Verdict FAIL until B1 and B2 close.
- 2026-11-22 13:56 Main: round 3 applied by IpgPlannerRepair (B1 layout decided by the P4 test oracle, B2 class names, two nits). Next: fresh reviewer IpgReviewer4; only blocking defects fail.
- 2026-11-22 14:00 IpgReviewer4: verdict PASS, fourth pass, scope whole plan, read with docs/design.md and docs/phases.md. Read-only; no code run. The review shell allows only redirects, so `date` could not run and the stamp is the one in my brief.
  B1 closed: layout constants are left to the P4 layout tests as oracle (phases.md:86, design.md:13). Scaling check: turn and chip positions all scale with c, r0, cChip and GAP; the 119 and 103 rectangle offsets are fixed; golden-angle angles never coincide for distinct ordinals, so a passing set exists.
  B2 closed: `.hub`/`.focus`, `.card`/`.latest`, `.kind-*`, `.chip` (phases.md:95) match the witness check (phases.md:111).
  Nits 1 and 2 closed (phases.md:25, 28).
  New nits, not blocking: (a) P4 Files (phases.md:86-87) omits docs/design.md, which P4 and design.md:13 require the implementer to edit; (b) "no upper cap" (phases.md:86) lets the implementer land on values that pass but look wrong; ask for the smallest passing values; (c) export names of the position and Rcl functions are unfixed; harmless, one implementer writes code and test.
  Findings: none blocking; B1 closed (design.md:13; phases.md:86); B2 closed (phases.md:95, 111); nits 1-2 closed (phases.md:25, 28); new nits phases.md:86-87, phases.md:86. Verdict PASS.
- 2026-11-22 14:05 IpgReviewer4: PLAN REVIEW: PASS — redundant: none — inefficient: phases.md:86 (no cap on layout tuning; ask for smallest passing values) — insecure: none
  Findings: phases.md:86-87 P4 Files omits docs/design.md, which P4 and design.md:13 require the implementer to edit (nit, not blocking); phases.md:86 no upper cap (nit, see inefficient); phases.md:86 export names of position and Rcl functions unfixed (nit). No blocking defects; B1 and B2 closed.
- 2026-11-22 13:58 Main: IpgImplP1 (grok) failed at spawn with 402 out of credits; it made no change. Respawning P1 with haiku (GLM quota-limited until 2026-11-23). Findings: none
- 2026-11-22 14:20 Main (entered on behalf of IpgImplP1Haiku, which cannot write the plan): P1 implemented, committed `24c5983` on master (15 files; root commit; no push). Implementer ran: bun test test/omp.test.ts test/tail.test.ts 32 pass; bunx tsc --noEmit exit 0. Main verify: `bash scripts/verify-p1.sh <143 MB session>` printed "P1 verify OK" (exit 0, 2.3 s total, 20 newest real sessions 33-87 ms each); `bun src/cli.ts turns --harness omp --session-file <143 MB session>` 2035 turns in 0.55 s (budget 3 s); mode 755 on src/cli.ts and scripts/verify-p1.sh. Open: `ipg turns | head` ends with EPIPE stack trace (cli.ts:50, nit); collab-prompt sample check done in design I5 by planner; docs/ not yet committed. Findings: EPIPE on closed stdout at src/cli.ts:50 (nit, fix in P3 with the CLI work).
