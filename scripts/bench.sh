#!/usr/bin/env bash
# T029 / NFR-001: process-cold p95 for `seat status --plain` must be ≤ 150ms.
#
# Runs against a synthetic PI_CODING_AGENT_DIR (never the live store) with a
# seeded seat.json. hyperfine spawns a fresh bun process per run (process-cold
# by construction); the run count is fixed here, not left to hyperfine's
# auto-calibration, so the protocol is reproducible.
set -euo pipefail
cd "$(dirname "$0")/.."

RUNS=30
THRESHOLD_MS=150

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

cat > "$SANDBOX/seat.json" <<'EOF'
{
	"version": 1,
	"providers": {
		"anthropic": {
			"default": "work",
			"profiles": {
				"work": { "type": "oauth", "refresh": "rt-w", "access": "at-w", "expires": 1900000000000 },
				"personal": { "type": "oauth", "refresh": "rt-p", "access": "at-p", "expires": 1900000000000 }
			},
			"aliases": { "w": "work", "p": "personal" }
		}
	}
}
EOF
chmod 600 "$SANDBOX/seat.json"

hyperfine \
	--runs "$RUNS" \
	--export-json "$SANDBOX/bench.json" \
	"PI_CODING_AGENT_DIR=$SANDBOX bun src/cli/main.ts status --plain" \
	>&2

P95_MS=$(bun -e '
const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const times = doc.results[0].times.slice().sort((a, b) => a - b);
const idx = Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1);
console.log((times[idx] * 1000).toFixed(1));
' "$SANDBOX/bench.json")

echo "seat status --plain: p95 = ${P95_MS}ms over ${RUNS} process-cold runs (threshold ${THRESHOLD_MS}ms)"
bun -e 'process.exit(Number(process.argv[1]) <= Number(process.argv[2]) ? 0 : 1)' "$P95_MS" "$THRESHOLD_MS" \
	|| { echo "BENCH FAIL: p95 ${P95_MS}ms exceeds ${THRESHOLD_MS}ms" >&2; exit 1; }
echo "bench: pass"
