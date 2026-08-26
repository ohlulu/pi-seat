#!/usr/bin/env bash
# T019 extension smoke: load the extension via Pi RPC mode under a synthetic
# PI_CODING_AGENT_DIR seeded with fixture legacy + auth files.
#
# Pass signal: the extension registers its /seat command (T049 — it used to be
# the migration side effect; the migration subsystem has since been removed
# entirely). The legacy
# fixture stays in the sandbox on purpose: AC-020 says a legacy file next to the
# store must not turn a session start into a write, so "sandbox seat.json was
# NOT created" is now part of the pass signal.
#
# Live ~/.pi/agent auth.json / claude-profiles.json / seat.json are asserted
# byte-identical before and after.
set -euo pipefail
cd "$(dirname "$0")/.."

LIVE_DIR="$HOME/.pi/agent"
LIVE_FILES=(auth.json claude-profiles.json seat.json)

hash_or_absent() {
	if [[ -f "$1" ]]; then shasum -a 256 "$1" | cut -d' ' -f1; else echo absent; fi
}

declare -a BEFORE
for f in "${LIVE_FILES[@]}"; do BEFORE+=("$(hash_or_absent "$LIVE_DIR/$f")"); done

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# The exact fixture the retired migration path imported from: `active` = work,
# auth.json byte-matching work, one dormant profile that would have been
# importable. Kept: AC-020's invariant is about a legacy file merely existing.
cat > "$SANDBOX/claude-profiles.json" <<'EOF'
{"active":"work","profiles":{"work":{"type":"oauth","refresh":"rt-work","access":"at-work","expires":1900000000000},"dormant":{"type":"oauth","refresh":"rt-dormant","access":"at-dormant","expires":1900000000000}},"aliases":{"d":"dormant","w":"work"},"identities":{}}
EOF
cat > "$SANDBOX/auth.json" <<'EOF'
{"anthropic":{"type":"oauth","refresh":"rt-work","access":"at-work","expires":1900000000000}}
EOF
LEGACY_BEFORE=$(hash_or_absent "$SANDBOX/claude-profiles.json")
AUTH_BEFORE=$(hash_or_absent "$SANDBOX/auth.json")

echo '{"type":"get_commands"}' \
	| PI_CODING_AGENT_DIR="$SANDBOX" pi --mode rpc -ne -e ./src/extension/index.ts --no-session \
	> "$SANDBOX/rpc-out.jsonl"

# --- Assertions -------------------------------------------------------------
fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

grep -q '"command":"get_commands"' "$SANDBOX/rpc-out.jsonl" \
	|| fail "RPC get_commands got no response (extension load or RPC startup broke)"

# Pass signal: the command is registered, which only happens if the entry ran to
# completion under a real Pi load.
#
# `process.exit(1)`, not `throw`: an uncaught throw in `bun -e` still exits 0, so
# a thrown assertion here is a check that can never fail. Both branches below are
# mutation-verified (rename the command, and the smoke goes red).
bun -e '
const fs = require("node:fs");
const names = [];
for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) {
	let event;
	try { event = JSON.parse(line); } catch { continue; }
	if (event.type !== "response" || event.command !== "get_commands") continue;
	if (event.success !== true) {
		console.error("get_commands failed: " + line);
		process.exit(1);
	}
	for (const command of event.data?.commands ?? []) names.push(command?.name);
}
if (!names.includes("seat")) {
	console.error("/seat not registered; got: " + (names.join(", ") || "(none)"));
	process.exit(1);
}
' "$SANDBOX/rpc-out.jsonl" || fail "extension loaded but did not register /seat"

# AC-020: a legacy file was sitting right there and load still wrote nothing.
if [[ -f "$SANDBOX/seat.json" ]]; then
	fail "extension load created seat.json — loading must never write to the store"
fi

[[ "$(hash_or_absent "$SANDBOX/claude-profiles.json")" == "$LEGACY_BEFORE" ]] || fail "sandbox legacy file was modified"
[[ "$(hash_or_absent "$SANDBOX/auth.json")" == "$AUTH_BEFORE" ]] || fail "sandbox auth.json was modified"

for i in "${!LIVE_FILES[@]}"; do
	AFTER=$(hash_or_absent "$LIVE_DIR/${LIVE_FILES[$i]}")
	[[ "$AFTER" == "${BEFORE[$i]}" ]] || fail "LIVE file changed: $LIVE_DIR/${LIVE_FILES[$i]}"
done

echo "smoke-extension: pass"
