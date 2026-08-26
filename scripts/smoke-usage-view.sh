#!/usr/bin/env bash
# T045 usage-view smoke (REQ-010 / AC-018): drive a REAL Pi TUI session in tmux,
# open the view with /seat, assert the meters render, press q, and assert the
# session is still alive afterwards.
#
# A unit test cannot cover the part that actually breaks here: Pi's differential
# renderer throws "Rendered line N exceeds terminal width" from its own loop, a
# tick after render() returned, and that kills the session. Only a real terminal
# proves it does not.
#
# The sandbox holds a synthetic PI_CODING_AGENT_DIR with a fixture seat.json;
# usage requests go to a local mock through the loopback-only endpoint override.
# Live ~/.pi/agent files are asserted byte-identical before and after.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

command -v tmux >/dev/null || fail "tmux is required for the usage-view smoke"

LIVE_DIR="$HOME/.pi/agent"
LIVE_FILES=(auth.json claude-profiles.json seat.json)
hash_or_absent() {
	if [[ -f "$1" ]]; then shasum -a 256 "$1" | cut -d' ' -f1; else echo absent; fi
}
declare -a BEFORE
for f in "${LIVE_FILES[@]}"; do BEFORE+=("$(hash_or_absent "$LIVE_DIR/$f")"); done

SANDBOX=$(mktemp -d)
SESSION="seat-usage-view-$$"
MOCK_PID=""
cleanup() {
	tmux kill-session -t "$SESSION" 2>/dev/null || true
	[[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true
	rm -rf "$SANDBOX"
}
trap cleanup EXIT

EXPIRES=$(( ($(date +%s) + 86400) * 1000 ))
RESETS=$(date -u -r $(( $(date +%s) + 9000 )) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+150 minutes" +%Y-%m-%dT%H:%M:%SZ)

cat > "$SANDBOX/seat.json" <<EOF
{"version":1,"providers":{"anthropic":{"default":"work","profiles":{"work":{"type":"oauth","refresh":"rt-work","access":"at-work","expires":$EXPIRES}},"aliases":{"w":"work"}}}}
EOF
chmod 600 "$SANDBOX/seat.json"
echo '{}' > "$SANDBOX/auth.json"
chmod 600 "$SANDBOX/auth.json"

# Mock usage endpoint on loopback; the port is chosen by the OS and written out.
cat > "$SANDBOX/mock.ts" <<EOF
const server = Bun.serve({
	port: 0,
	fetch: () =>
		Response.json({ limits: [{ kind: "session", percent: 42, resets_at: "$RESETS" }] }),
});
await Bun.write("$SANDBOX/port", String(server.port));
EOF
bun "$SANDBOX/mock.ts" &
MOCK_PID=$!
disown "$MOCK_PID" 2>/dev/null || true # keep the kill in cleanup quiet
for _ in $(seq 1 50); do [[ -s "$SANDBOX/port" ]] && break; sleep 0.1; done
[[ -s "$SANDBOX/port" ]] || fail "mock usage endpoint did not start"
PORT=$(cat "$SANDBOX/port")

tmux new-session -d -s "$SESSION" -x 100 -y 30 \
	"PI_CODING_AGENT_DIR='$SANDBOX' SEAT_CLAUDE_USAGE_URL='http://127.0.0.1:$PORT/claude' \
	 pi -ne -e ./src/extension/index.ts --no-session"

wait_for() { # pattern, seconds
	for _ in $(seq 1 $(( $2 * 5 ))); do
		tmux capture-pane -p -t "$SESSION" 2>/dev/null | grep -qF "$1" && return 0
		sleep 0.2
	done
	return 1
}

wait_for "[Extensions]" 20 || {
	tmux capture-pane -p -t "$SESSION" >&2 || true
	fail "pi TUI never came up"
}

# The banner is not readiness: a submit before startup finishes is answered with
# "Startup is still in progress" and the text is put back in the editor
# (interactive-mode.js handleStartupSubmit). So type once, then keep pressing
# Enter until the view's own strings appear — not the transcript's echo of the
# command. Extra Enters land harmlessly once it is open.
tmux send-keys -t "$SESSION" "/seat"
opened=0
for _ in $(seq 1 15); do
	tmux send-keys -t "$SESSION" Enter
	if wait_for "esc/q close" 2; then opened=1; break; fi
done
[[ "$opened" == 1 ]] || {
	tmux capture-pane -p -t "$SESSION" >&2
	fail "the usage view never opened"
}
PANE=$(tmux capture-pane -p -t "$SESSION")
grep -qF "█" <<<"$PANE" || { echo "$PANE" >&2; fail "no meter bars in the view"; }
grep -qF "42%" <<<"$PANE" || { echo "$PANE" >&2; fail "the mocked percentage is missing"; }
grep -qF "ANTHROPIC · work (default)" <<<"$PANE" || { echo "$PANE" >&2; fail "provider section header is missing"; }
grep -qi "exceeds terminal width" <<<"$PANE" && { echo "$PANE" >&2; fail "renderer reported an overflowing row"; }

tmux send-keys -t "$SESSION" "q"
for _ in $(seq 1 50); do
	tmux capture-pane -p -t "$SESSION" | grep -qF "esc/q close" || break
	sleep 0.2
done
PANE=$(tmux capture-pane -p -t "$SESSION")
grep -qF "esc/q close" <<<"$PANE" && { echo "$PANE" >&2; fail "q did not close the view"; }

# Still alive: the session must accept input after the view is gone.
tmux has-session -t "$SESSION" 2>/dev/null || fail "the pi session died with the view"
tmux send-keys -t "$SESSION" "/seat whoami" Enter
# whoami is the offline text report (never a component), so its header proves
# the extension is still handling commands.
wait_for "seat status" 15 || {
	tmux capture-pane -p -t "$SESSION" >&2
	fail "the session stopped responding to commands after the view closed"
}

for i in "${!LIVE_FILES[@]}"; do
	AFTER=$(hash_or_absent "$LIVE_DIR/${LIVE_FILES[$i]}")
	[[ "$AFTER" == "${BEFORE[$i]}" ]] || fail "LIVE file changed: $LIVE_DIR/${LIVE_FILES[$i]}"
done

echo "smoke-usage-view: pass"
