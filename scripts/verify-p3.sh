#!/usr/bin/env bash
# P3 witness: unit tests and typecheck, then a live daemon serving the given session.
set -euo pipefail

SESSION="${1:?usage: scripts/verify-p3.sh <session.jsonl>}"
SESSION="$(cd "$(dirname "$SESSION")" && pwd)/$(basename "$SESSION")"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
# The daemon resolves session keys under the OMP agent dir: sessions/<dir>/<file> sits two levels below it.
export PI_CODING_AGENT_DIR="$(cd "$(dirname "$SESSION")/../.." && pwd)"

TMP="$(mktemp -d)"
export XDG_STATE_HOME="$TMP/state" XDG_CONFIG_HOME="$TMP/config"
OUT="$TMP/events.txt"
S=""
C=""
cleanup() {
  if [ -n "$C" ]; then kill "$C" 2>/dev/null || true; fi
  if [ -n "$S" ]; then kill "$S" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== bun test"
bun test

echo "== tsc"
bunx tsc --noEmit

P=$((20000 + RANDOM % 10000))
echo "== serve on port $P"
bun src/cli.ts serve --port "$P" &
S=$!

ready=0
for _ in $(seq 100); do
  if curl -sf "http://127.0.0.1:$P/health" | grep -q '"app":"intent-prompt-graph"'; then
    ready=1
    break
  fi
  sleep 0.1
done
if [ "$ready" != 1 ]; then
  echo "daemon did not answer on port $P"
  exit 1
fi

URL="$(bun src/cli.ts open --no-browser --harness omp --session-file "$SESSION" --port "$P")"
echo "url: $URL"
KEY="${URL#*/s/omp/}"
KEY="${KEY%#latest}"

start=$(date +%s%N)
curl -sN --max-time 15 "http://127.0.0.1:$P/api/s/omp/$KEY/events" > "$OUT" &
C=$!

got=0
for _ in $(seq 200); do
  if grep -q '"type":"snapshot"' "$OUT" 2>/dev/null; then
    got=1
    break
  fi
  sleep 0.05
done
ms=$(( ($(date +%s%N) - start) / 1000000 ))

if [ "$got" != 1 ]; then
  echo "no snapshot in 10 s"
  exit 1
fi
echo "first-event ${ms} ms"
if [ "$ms" -ge 3000 ]; then
  echo "first event took ${ms} ms, over 3000 ms"
  exit 1
fi
echo "P3 verify: PASS"
