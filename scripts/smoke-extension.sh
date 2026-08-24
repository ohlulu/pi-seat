#!/usr/bin/env bash
# T019 extension smoke: load the extension via Pi RPC mode under a synthetic
# PI_CODING_AGENT_DIR seeded with fixture legacy + auth files.
#
# Pass signal: the sandbox migration side effect (sandbox seat.json created per
# REQ-008 rules), with the live ~/.pi/agent auth.json / claude-profiles.json /
# seat.json asserted byte-identical before and after.
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

# Legacy fixture: `active` = work; auth.json's grant byte-matches work as well.
# Expected import: dormant only (work excluded by rules 1+2), alias d follows,
# alias w dropped with its excluded profile.
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

[[ -f "$SANDBOX/seat.json" ]] || fail "sandbox seat.json was not created"

bun -e '
const fs = require("node:fs");
const store = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const a = store.providers?.anthropic ?? {};
const labels = Object.keys(a.profiles ?? {});
if (store.version !== 1) throw new Error("store version != 1");
if (labels.join(",") !== "dormant") throw new Error(`expected only dormant imported, got: ${labels}`);
if (a.profiles.dormant.refresh !== "rt-dormant") throw new Error("dormant credential mismatch");
if (JSON.stringify(a.aliases) !== JSON.stringify({ d: "dormant" })) throw new Error(`aliases wrong: ${JSON.stringify(a.aliases)}`);
if (a.default !== undefined) throw new Error("no default should be set by migration");
' "$SANDBOX/seat.json" || fail "sandbox seat.json content violates REQ-008 rules"

grep -q '"command":"get_commands"' "$SANDBOX/rpc-out.jsonl" || fail "RPC get_commands got no response (extension load or RPC startup broke)"

[[ "$(hash_or_absent "$SANDBOX/claude-profiles.json")" == "$LEGACY_BEFORE" ]] || fail "sandbox legacy file was modified"
[[ "$(hash_or_absent "$SANDBOX/auth.json")" == "$AUTH_BEFORE" ]] || fail "sandbox auth.json was modified"

for i in "${!LIVE_FILES[@]}"; do
	AFTER=$(hash_or_absent "$LIVE_DIR/${LIVE_FILES[$i]}")
	[[ "$AFTER" == "${BEFORE[$i]}" ]] || fail "LIVE file changed: $LIVE_DIR/${LIVE_FILES[$i]}"
done

echo "smoke-extension: pass"
