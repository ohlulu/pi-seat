#!/usr/bin/env python3
"""seat — Pi claude account switcher and usage meter.

Swaps the "anthropic" entry in ~/.pi/agent/auth.json between named profiles
stored in ~/.pi/agent/claude-profiles.json. Only the anthropic key is touched;
other providers (codex, gemini) are left alone.

Examples:
  seat save work -a w    Store the current anthropic credential as "work",
                         with "w" as an alias
  seat w                 Switch to "work" via its alias
  seat personal          Switch to "personal" (shorthand for `seat use personal`)
  seat                   Show usage bars for every account (Claude + Codex)
  seat status            Show the active profile and every stored profile
  seat rename work day   Rename a profile (its aliases follow)
  seat rm w              Delete an alias; deleting a profile asks first
  seat whoami            Name the profile auth.json's credential really
                         belongs to (asks the server when it must)
  seat status --plain | awk -F'\t' '$2=="active"{print $1}'
                         Active label only, for a shell prompt segment

Usage:
  seat                                   usage (shorthand)
  seat <label>|<alias> [-a <alias>]      switch (shorthand)
  seat use <label>|<alias> [-a <alias>]  switch (explicit; always reachable)
  seat save <label> [-a <alias>] [--force] [--no-input]
  seat rm <label>|<alias> [--force] [--no-input]
  seat rename <old> <new>
  seat usage [--json]
  seat status [--plain]
  seat whoami [--plain]
  seat (-h | --help | --version)

`-a <alias>` is repeatable and points an extra name at the profile. Switching
resolves aliases; `seat rm <alias>` removes only the alias itself.

Output: primary output on stdout, diagnostics and prompts on stderr.
`--plain` prints one TSV row per profile:
<label> <active|-> <expires_ms|-> <comma-joined-aliases|->.

`usage` — what bare `seat` runs — draws the 5h/weekly limit bars for every
Claude account, plus Codex when auth.json holds one, from the same endpoints
OpenUsage reads. One block per account: a filled dot for the credential
auth.json holds right now, a hollow one for a dormant profile, then the label
and its aliases. Columns size themselves to the terminal — the reset clock,
then the label column, give way before the bar does, so nothing wraps in a
narrow pane. The live account renders from auth.json, dormant ones from the
store; the owner comes from the same attribution as `whoami`. An
unattributable credential renders as "unidentified" — display only, never a
key — and hides no profile behind itself. The endpoint answers only for a
live access token: a provably expired live credential gets one delegated
`pi auth check`, an expired dormant one just prints how to wake it. `--json`
emits {"anthropic": <usage>, "openai-codex": <usage>}; with stored profiles
the anthropic value is {"active": <label|null>, "profiles": {<label>:
<usage>}}, and an unattributable live credential's usage sits under
"unattributed" with active null. Fine to check by hand; do not poll it at
high frequency — the Claude endpoint rate-limits aggressively.

Exit codes: 0 ok, 1 operation failed, 2 bad invocation.

Note: running pi sessions pick the switch up on their next provider request
(pi >= 0.84.0 re-reads auth.json whenever its file revision changes). Only the
cached model-availability list stays stale — open /model to refresh it.

Identity: a credential names no account, and pi's /login can replace the one in
auth.json without seat noticing, so seat resolves whose it is before overwriting
any profile — by byte-equality while auth.json is untouched, otherwise through
Anthropic's OAuth profile endpoint, recorded per label under "identities".
Anything it cannot prove aborts the whole operation instead of guessing;
`seat save <new-label>` keeps an unrecognised credential and needs no network.
That endpoint only answers for a live access token, so a credential pi rotated
and then let expire is handed to `pi auth check` for one refresh first: pi owns
that grant, and a seat racing it would spend the single-use refresh token twice.

Env overrides (for testing): SEAT_AUTH_PATH, SEAT_PROFILES_PATH
"""

import atexit
import collections
import datetime
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.request

VERSION = "2.3.0"

AUTH_PATH = os.environ.get(
    "SEAT_AUTH_PATH", os.path.expanduser("~/.pi/agent/auth.json")
)
PROFILES_PATH = os.environ.get(
    "SEAT_PROFILES_PATH", os.path.expanduser("~/.pi/agent/claude-profiles.json")
)
PROVIDER = "anthropic"

# An OAuth credential carries no account field, so the only way to ask whose it
# is is to ask the server. The first-party Claude Code client (2.1.212) resolves
# tokens here with a Bearer GET, a 10s timeout and no-cache, and strict-validates
# account.uuid/email plus organization.uuid: undocumented, but not incidental.
PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
IDENTITY_TIMEOUT_S = 10.0

# Refreshing is pi's job, never seat's -- see refresh_through_pi. `auth check`
# refreshes an expired OAuth credential by default and prints one status word.
PI_REFRESH_CMD = ("pi", "auth", "check", "--provider", PROVIDER)
# Node startup plus pi's own 15s refresh timeout, with room for a slow network.
REFRESH_TIMEOUT_S = 30.0

LOCK_TIMEOUT_S = 3.0
# Pi takes the same `auth.json.lock` directory through proper-lockfile, on two
# paths with different lifetimes: the sync one inherits the 10s default, the
# async one passes `stale: 30_000` and refreshes the mtime every 15s
# (core/auth-storage.js). Stay above the longer of the two, or a slow token
# refresh looks stale and seat steals a lock Pi still holds. The cost of the
# higher bound is bounded: seat's own critical section is milliseconds, so this
# only delays recovery from a seat killed between mkdir and rmdir.
LOCK_STALE_S = 45.0

EXIT_FAIL = 1
EXIT_USAGE = 2


def die(msg: str, code: int = EXIT_FAIL) -> "None":
    print(f"seat: {msg}", file=sys.stderr)
    sys.exit(code)


# MARK: - Locking (compatible with pi's proper-lockfile: <file>.lock dir)


class AuthLock:
    """Serializes every mutation of auth.json and claude-profiles.json.

    One lock guards both files: seat only ever writes them together, and the
    critical section is a few milliseconds, so a single lock is simpler than
    ordering two. Never hold this across a prompt — see confirm().
    """

    def __init__(self, path: str):
        self.lock_dir = path + ".lock"

    def __enter__(self):
        deadline = time.monotonic() + LOCK_TIMEOUT_S
        while True:
            try:
                os.mkdir(self.lock_dir)
                return self
            except FileExistsError:
                if self._take_if_stale():
                    continue
                if time.monotonic() > deadline:
                    die(
                        f"{os.path.basename(AUTH_PATH)} is locked by another process "
                        f"({self.lock_dir}); retry, or remove that directory if no "
                        f"pi/seat is running"
                    )
                time.sleep(0.05)

    def _take_if_stale(self) -> bool:
        """True when the lock was gone or reclaimed, so mkdir is worth retrying."""
        try:
            age = time.time() - os.stat(self.lock_dir).st_mtime
        except OSError:
            return True  # released while we looked
        if age <= LOCK_STALE_S:
            return False
        try:
            os.rmdir(self.lock_dir)
        except OSError:
            return False  # non-empty or racing holder; wait it out instead
        print(f"seat: removed a stale lock ({int(age)}s old)", file=sys.stderr)
        return True

    def __exit__(self, *exc):
        # Safe to drop unconditionally: we hold it for milliseconds, far below
        # the staleness window in which anyone else would reclaim it.
        try:
            os.rmdir(self.lock_dir)
        except OSError:
            pass


# MARK: - File IO


def read_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as e:
        die(f"{path} is not valid JSON: {e}")
    except OSError as e:
        die(f"cannot read {path}: {e}")


def write_json_600(path: str, data) -> None:
    """Atomic write with mode 600."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".seat-")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_store() -> dict:
    """Read claude-profiles.json, validating the shape a human may have edited."""
    raw = read_json(PROFILES_PATH, None)
    if raw is None:
        return {"active": None, "profiles": {}, "aliases": {}, "identities": {}}
    if not isinstance(raw, dict):
        die(f"{PROFILES_PATH}: expected a JSON object at the top level")
    profiles = raw.get("profiles") or {}
    if not isinstance(profiles, dict):
        die(f"{PROFILES_PATH}: 'profiles' must be a JSON object")
    for label, cred in profiles.items():
        if not isinstance(cred, dict):
            die(f"{PROFILES_PATH}: profile '{label}' must be a JSON object")
    active = raw.get("active")
    if not isinstance(active, str):
        active = None
    aliases = raw.get("aliases") or {}
    if not isinstance(aliases, dict):
        die(f"{PROFILES_PATH}: 'aliases' must be a JSON object")
    for name, target in aliases.items():
        if not isinstance(target, str):
            die(f"{PROFILES_PATH}: alias '{name}' must map to a label string")
    # Top-level, never inside a profile: do_switch copies the whole profile dict
    # into auth.json, so anything stored there leaks into the credential file and
    # is thrown away on pi's next refresh. Same reason `aliases` lives out here.
    identities = raw.get("identities") or {}
    if not isinstance(identities, dict):
        die(f"{PROFILES_PATH}: 'identities' must be a JSON object")
    for label, ident in identities.items():
        if not isinstance(ident, dict):
            die(f"{PROFILES_PATH}: identity '{label}' must be a JSON object")
    return {
        "active": active,
        "profiles": profiles,
        "aliases": aliases,
        "identities": identities,
    }


def load_auth() -> dict:
    auth = read_json(AUTH_PATH, {})
    if not isinstance(auth, dict):
        die(f"{AUTH_PATH}: expected a JSON object at the top level")
    cur = auth.get(PROVIDER)
    if cur is not None and not isinstance(cur, dict):
        die(f"{AUTH_PATH}: '{PROVIDER}' must be a JSON object")
    return auth


def current_credential(auth: dict) -> dict:
    cur = auth.get(PROVIDER)
    if not cur:
        die(f"no {PROVIDER} credential in {AUTH_PATH} — run /login in pi first")
    return cur


# MARK: - Identity


class IdentityError(Exception):
    """The server could not be asked, or did not answer usefully."""


def fetch_identity(access: str) -> dict:
    """Resolve an access token to the account/organization that issued it.

    A network round-trip: callers must not hold AuthLock across it, for the same
    reason confirm() must not.
    """
    if not isinstance(access, str) or not access:
        raise IdentityError("the credential carries no access token")
    req = urllib.request.Request(
        PROFILE_URL,
        headers={
            "Authorization": f"Bearer {access}",
            "Accept": "application/json",
            "Cache-Control": "no-cache",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=IDENTITY_TIMEOUT_S) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise IdentityError(
                "the access token is expired or rejected"
            ) from None
        raise IdentityError(f"the identity lookup returned HTTP {e.code}") from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as e:
        raise IdentityError(f"the identity lookup could not reach the server ({e})") from None
    except (ValueError, UnicodeDecodeError):
        raise IdentityError("the identity lookup returned a malformed response") from None
    account = body.get("account")
    org = body.get("organization") or {}
    if not isinstance(account, dict) or not isinstance(org, dict):
        raise IdentityError("the identity lookup returned an unexpected shape")
    if not account.get("uuid"):
        raise IdentityError("the identity lookup returned no account uuid")
    return {
        "account_uuid": account["uuid"],
        "organization_uuid": org.get("uuid"),
        # Everything below is display only. An organization can be renamed and a
        # seat retiered, so these are last-seen values and never identity.
        "account_email": account.get("email"),
        "organization_name": org.get("name"),
        "seat_tier": org.get("seat_tier"),
        "observed_at": int(time.time() * 1000),
    }


def same_identity(a, b) -> bool:
    """Identity is the (account, organization) pair, not the account alone: one
    account can hold a personal plan and a team seat at the same time."""
    if not isinstance(a, dict) or not isinstance(b, dict):
        return False
    if not a.get("account_uuid"):
        return False
    return a.get("account_uuid") == b.get("account_uuid") and a.get(
        "organization_uuid"
    ) == b.get("organization_uuid")


def access_is_live(cred: dict) -> bool:
    """True when the identity endpoint will still answer for this credential.

    pi stores `expires` five minutes early, so this errs in the only safe
    direction: it can call a live token dead, never a dead one live.
    """
    exp = cred.get("expires")
    return isinstance(exp, (int, float)) and exp / 1000 > time.time()


def stored_verbatim(cred: dict, store: dict) -> bool:
    """True when byte-equality can name the owner, so no live token is needed."""
    return any(c == cred for c in store["profiles"].values())


def refresh_through_pi(auth: dict, why: str = "nothing can identify its credential") -> dict:
    """Have pi refresh auth.json in place; return it as it stands afterwards.

    seat must never POST the refresh grant itself. An Anthropic refresh token is
    single-use, so a seat racing a running pi session leaves one of the two
    holding a spent token -- the `invalid_grant` that costs a full re-login, and
    the exact damage the rest of this file exists to prevent. pi's own path takes
    auth.json.lock and re-checks expiry under it, so delegating is the only safe
    way to turn a rotated-and-expired credential back into an identifiable one.

    Never call this holding AuthLock: pi wants that same lock. And never read the
    outcome off pi's exit code -- `cli/auth-check.js` collapses a rejected
    refresh, an unreachable server and a broken runtime into one `invalid_state`.
    auth.json answers it unambiguously instead.
    """
    print(
        f"seat: auth.json's access token has expired, so {why}; asking pi to "
        f"refresh it",
        file=sys.stderr,
    )
    # Both processes have to mean the same auth.json. Under SEAT_AUTH_PATH they
    # otherwise diverge, and seat would attribute a sandbox credential while pi
    # rotated the real one -- a test run spending the live refresh token. In
    # production this resolves to the directory pi would have picked anyway.
    env = dict(os.environ, PI_CODING_AGENT_DIR=os.path.dirname(AUTH_PATH) or ".")
    try:
        subprocess.run(
            PI_REFRESH_CMD, capture_output=True, timeout=REFRESH_TIMEOUT_S, env=env
        )
    except FileNotFoundError:
        print("seat: `pi` is not on PATH, so it stays unidentifiable", file=sys.stderr)
        return auth
    except (OSError, subprocess.SubprocessError) as e:
        print(f"seat: `pi auth check` did not complete ({e})", file=sys.stderr)
        return auth
    refreshed = load_auth()
    if not access_is_live(refreshed.get(PROVIDER) or {}):
        print(
            "seat: pi could not refresh it -- either that account has to be logged "
            "in again, or the server was unreachable",
            file=sys.stderr,
        )
    return refreshed


def attribute(cred: dict, store: dict):
    """Which stored profile does this credential belong to? -> (label, why).

    `active` cannot answer it: pi's /login rewrites auth.json without telling
    seat, so the pointer can name a profile the credential has nothing to do
    with. Byte-equality answers it offline; otherwise only the server can, since
    every pi refresh rotates BOTH tokens and leaves nothing local to compare.
    Returns (None, reason) rather than guessing.
    """
    profiles = store["profiles"]
    exact = [l for l, c in profiles.items() if c == cred]
    if len(exact) == 1:
        return exact[0], "exact"
    if exact:
        return None, f"the same credential is stored under {', '.join(sorted(exact))}"
    try:
        ident = fetch_identity(cred.get("access"))
    except IdentityError as e:
        return None, str(e)
    matches = [l for l in profiles if same_identity(store["identities"].get(l), ident)]
    if len(matches) == 1:
        return matches[0], "identity"
    if matches:
        return None, f"that identity matches {', '.join(sorted(matches))}"
    return None, "no stored profile carries this account's identity"


def attribute_or_die(cred: dict, store: dict) -> str:
    label, why = attribute(cred, store)
    if label is None:
        die(
            f"cannot tell which profile the credential in auth.json belongs to "
            f"({why}).\nseat will not overwrite a profile on a guess — run "
            f"`seat save <label>` to keep this credential under a name first."
        )
    return label


# MARK: - Argument helpers


def take_flags(args, allowed):
    flags, rest = set(), []
    for a in args:
        if a.startswith("-"):
            if a not in allowed:
                die(f"unknown flag '{a}'. see `seat --help`", EXIT_USAGE)
            flags.add(a)
        else:
            rest.append(a)
    return flags, rest


def validate_label(label: str) -> str:
    """Guard new labels only. `use`/`rm`/`rename` accept anything already stored,
    so a label saved before a command of that name existed stays reachable."""
    if not label.strip():
        die("label cannot be empty", EXIT_USAGE)
    if label.startswith("-"):
        die(f"label cannot start with '-' (got {label!r})", EXIT_USAGE)
    if label in COMMANDS:
        die(f"'{label}' is a seat command, pick another label", EXIT_USAGE)
    return label


def split_alias_flags(args):
    """Pull repeatable `-a <name>` / `--alias <name>` out of args, order-free."""
    names, rest = [], []
    i = 0
    while i < len(args):
        if args[i] in ("-a", "--alias"):
            if i + 1 >= len(args):
                die(f"{args[i]} needs a value. see `seat --help`", EXIT_USAGE)
            names.append(args[i + 1])
            i += 2
        else:
            rest.append(args[i])
            i += 1
    return names, rest


def validate_alias(store: dict, name: str, label: str) -> None:
    if not name.strip():
        die("alias cannot be empty", EXIT_USAGE)
    if name.startswith("-"):
        die(f"alias cannot start with '-' (got {name!r})", EXIT_USAGE)
    if any(c in name for c in ", \t\n"):
        die(f"alias cannot contain spaces or commas (got {name!r})", EXIT_USAGE)
    if name in COMMANDS:
        die(f"'{name}' is a seat command, pick another alias", EXIT_USAGE)
    if name == label or name in store["profiles"]:
        die(f"'{name}' is a profile label, pick another alias", EXIT_USAGE)


def apply_aliases(store: dict, label: str, names) -> list:
    """Point every alias in `names` at `label`; returns messages for stdout."""
    msgs = []
    for name in names:
        validate_alias(store, name, label)
        prev = store["aliases"].get(name)
        store["aliases"][name] = label
        was = f" (was -> '{prev}')" if prev and prev != label else ""
        msgs.append(f"alias '{name}' -> '{label}'{was}")
    return msgs


def resolve_target(store: dict, name: str) -> str:
    """Map an alias to its label. An exact profile name wins over an alias."""
    if name in store["profiles"]:
        return name
    return store["aliases"].get(name, name)


def unknown_profile(name: str, store: dict) -> "None":
    known = ", ".join(store["profiles"]) or "(none — run `seat save <label>` first)"
    msg = f"unknown profile or alias '{name}'. profiles: {known}"
    if store["aliases"]:
        msg += "; aliases: " + ", ".join(
            f"{a} -> {l}" for a, l in store["aliases"].items()
        )
    die(msg, EXIT_USAGE)


def confirm(question: str, flags) -> bool:
    """Ask before a destructive change. Callers must not hold the lock here."""
    if "--force" in flags:
        return True
    if "--no-input" in flags or not sys.stdin.isatty():
        die("refusing to continue without confirmation; re-run with --force")
    sys.stderr.write(f"{question} [y/N] ")
    sys.stderr.flush()
    try:
        answer = input()
    except (EOFError, KeyboardInterrupt):
        sys.stderr.write("\n")
        return False
    return answer.strip().lower() in ("y", "yes")


# MARK: - Usage

USAGE_TIMEOUT_S = 10.0

# Column widths, listed in the order a narrow terminal gives them up. The bar is
# the last thing to shrink and never drops below BAR_MIN, so even a 40-column
# herdr split renders a readable meter instead of a wrapped mess.
INDENT = 2
GAP = 2
PCT_W = 4  # "100%"
LABEL_W = 13  # "weekly Fable", "credits"
LABEL_W_SLIM = 8
RESET_W_LONG = 20  # "in 6d23h · Tue 11:59"
RESET_W_SHORT = 9  # "in 23h13m", "resetting"
BAR_MAX = 20
# Below BAR_COMFORT a meter reads as a blob, so the reset clock is not worth
# the columns it costs; below BAR_MIN it reads as nothing at all.
BAR_COMFORT = 14
BAR_MIN = 8

BAR_FULL = "█"
BAR_EMPTY = "░"
DOT_LIVE = "●"  # the credential auth.json holds right now
DOT_DORMANT = "○"  # stored, waiting for a switch

BOLD = "\033[1m"
DIM = "\033[2m"
RED = "\033[31m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
RESET = "\033[0m"
USE_COLOR = (
    sys.stdout.isatty()
    and not os.environ.get("NO_COLOR")
    and os.environ.get("TERM") != "dumb"
)


def colorize(code: str, text: str) -> str:
    return f"{code}{text}{RESET}" if USE_COLOR else text


# MARK: - Usage / layout

Layout = collections.namedtuple("Layout", "width label_w bar_w reset_w")


def plan_layout(width: int) -> Layout:
    """The widest column set that still fits, so no row ever has to wrap.

    Tiers run richest-first and each names the bar width it is worth paying
    for, so a luxury reset column is never bought with a bar too cramped to
    read. What that floor does NOT buy is a bar width monotonic in terminal
    width, and no ordering can: the reset clock costs 22 columns at the seam,
    so 59 columns gets a 20-wide bar and no clock while 60 gets 14 and one.
    A monotonic bar needs richer tiers gated on the bar already being at
    BAR_MAX, which pushes the clock out past 66 columns and leaves everything
    from 44 to 54 with a full-width bar and no reset time at all — the wrong
    trade, since the reset time is the half of a meter that says what to do.

    The invariant that does hold, and that the tests pin, is that no column
    ever gets worse as the terminal grows: the selected tier only moves
    richer, so label_w and reset_w are non-decreasing in width.

    Budget is width - 1, not width: a line landing exactly on the last column
    leaves many terminals in deferred-wrap state, which surfaces as a stray
    blank line the next time anything prints.
    """
    for label_w, reset_w, floor in (
        (LABEL_W, RESET_W_LONG, BAR_COMFORT),
        (LABEL_W, RESET_W_SHORT, BAR_COMFORT),
        (LABEL_W, RESET_W_SHORT, BAR_MIN),
        (LABEL_W_SLIM, RESET_W_SHORT, BAR_MIN),
        (LABEL_W_SLIM, 0, BAR_MIN),
    ):
        fixed = INDENT + label_w + GAP + GAP + PCT_W
        if reset_w:
            fixed += GAP + reset_w
        bar_w = width - 1 - fixed
        if bar_w >= floor:
            return Layout(width, label_w, min(bar_w, BAR_MAX), reset_w)
    return Layout(width, LABEL_W_SLIM, BAR_MIN, 0)


def term_layout() -> Layout:
    # get_terminal_size reads COLUMNS before it asks the tty, so a pipe and a
    # test both get a usable width instead of whatever a closed stdout reports.
    # Whatever it reports is used as-is: rounding a genuinely tiny terminal up
    # to something comfortable is how a layout that cannot wrap starts wrapping.
    # plan_layout's fallback tier is all positive constants, so even width 1
    # slices nothing negative — emit() just clips every line down to nothing.
    return plan_layout(shutil.get_terminal_size((80, 24)).columns)


def cell_width(text: str) -> int:
    """How many terminal cells `text` occupies — not how many code points.

    A CJK profile label is half as many code points as it is columns, so len()
    lets a line pass a width check and wrap anyway; `seat save 工作` is a
    perfectly ordinary thing to have done. East Asian Ambiguous deliberately
    counts as 1: every glyph this view is drawn from — the bars, the liveness
    dots, the middle dot, the ellipsis — is Ambiguous, so counting those as
    wide would mis-measure every single row to fix a rare label.
    """
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def cell_clip(text: str, width: int) -> str:
    """The longest prefix of `text` fitting `width` cells, … marking the cut."""
    if cell_width(text) <= width:
        return text
    if width <= 0:
        return ""
    kept, used = [], 0
    for char in text:
        size = cell_width(char)
        if used + size > width - 1:
            break
        kept.append(char)
        used += size
    # Stopping in front of a wide glyph can leave one cell over; spend it on
    # padding so the … still lands exactly on the last column.
    return "".join(kept) + " " * (width - 1 - used) + "\u2026"


def fit(text: str, width: int) -> str:
    """Pad or ellipsize to exactly `width` cells, so every column stays aligned."""
    size = cell_width(text)
    if size > width:
        return cell_clip(text, width)
    return text + " " * (width - size)


def emit(segments, width: int) -> None:
    """Print one line of (text, color) pairs, clipped so it cannot wrap.

    Color is applied after clipping: an escape sequence has no display width,
    so measuring a colorized string would silently over-fill every row.
    """
    parts, used = [], 0
    for text, code in segments:
        room = width - used
        if room <= 0:
            break
        text = cell_clip(text, room)
        parts.append(colorize(code, text) if code else text)
        used += cell_width(text)
    print("".join(parts).rstrip())


# MARK: - Usage / waiting

SPINNER_FRAMES = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f"
SPINNER_INTERVAL_S = 0.08
# Nothing is drawn until a step has been slow enough to be worth explaining.
# Under this, a spinner is a flash of noise between two frames of real output.
SPINNER_DELAY_S = 0.15


class Spinner:
    """A one-line progress indicator for the seconds `seat` spends on the wire.

    A bare `seat` is three sequential round-trips — whose credential is this,
    then usage per account — and the first one lands before any block can be
    drawn, so without this the command looks hung for about a second.

    One instance spans the whole command, because the steps are one continuous
    wait and should read as one: step() only swaps the label, so the line is
    never cleared and re-drawn between phases and the frame never restarts.
    Doing it the other way — an instance per step — blanked the line and served
    the start-up grace again at every boundary, which reads as a flicker.

    Always stderr, never stdout: the meters are stdout's, and a spinner's
    carriage returns interleaved into a redirect would corrupt them. Silent
    unless stderr is a terminal, so a pipe, a log and `--json` get nothing.
    """

    def __init__(self, enabled: bool = True):
        self.label = ""
        # Bind the stream once, rather than reading sys.stderr per write: the
        # object then draws on, tests, and erases the same terminal, and an
        # erase queued for exit cannot land on whatever stderr has become by
        # then — which is how a stray clear sequence reaches a stream this
        # spinner never wrote to.
        self._stream = sys.stderr
        self.enabled = (
            enabled
            and self._stream.isatty()
            and os.environ.get("TERM") != "dumb"
        )
        self._stop = threading.Event()
        self._thread = None
        self._frame = 0
        self._visible = False
        if self.enabled:
            # The line has to be retired on paths no `finally` here can see:
            # a die() deeper in the stack, or a Ctrl-C caught up in main().
            atexit.register(self._retire_at_exit)

    def step(self, label: str) -> None:
        """Show `label`, or swap it in if the animation is already running."""
        self.label = label
        if not self.enabled or self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._spin, daemon=True)
        self._thread.start()

    def hide(self) -> None:
        """Retire the line so stdout can be written to. Safe to call twice."""
        self._stop.set()
        if self._thread is not None:
            # Unbounded on purpose. The caller is about to write stdout, and
            # until this thread is provably gone it can still put a frame in
            # the middle of that write. A bounded join cannot be used here:
            # giving up while the thread is alive would clear the reference to
            # a writer that then resurrects _visible and draws over the block.
            # The only thing that blocks this join is a terminal that has
            # stopped accepting output, which stalls the stdout write it is
            # protecting anyway.
            self._thread.join()
            self._thread = None
        # Safe now: the thread is gone, so _visible cannot change under us and
        # the clear cannot be skipped by a frame drawn a microsecond too late.
        self._erase()

    def _erase(self) -> None:
        if not self._visible:
            return
        self._visible = False
        try:
            self._stream.write("\r\033[K")
            self._stream.flush()
        except ValueError:
            pass  # stderr already closed by interpreter shutdown

    def _retire_at_exit(self) -> None:
        """Bounded cleanup for the exit paths. Never hangs the interpreter.

        The difference from hide() is what is at stake. hide() is protecting a
        stdout write that is about to happen, so it has to wait however long
        that takes. Here nothing will be written again, so a thread that
        outlives the join can only lose a race with the process ending — and
        the one thing that would make it outlive the join is a blocked stderr,
        which would block this erase too. So give up quietly instead.
        """
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=1.0)
            if thread.is_alive():
                return
            self._thread = None
        self._erase()

    def _spin(self) -> None:
        # The grace is only owed when the line is blank. Continuing an animation
        # that is already on screen must not pause first — that is the flicker.
        if not self._visible and self._stop.wait(SPINNER_DELAY_S):
            return
        width = shutil.get_terminal_size((80, 24)).columns
        while True:
            # self.label is read fresh every frame; that is how step() relabels
            # a running spinner without touching the thread.
            text = cell_clip(f"{SPINNER_FRAMES[self._frame]} {self.label}", width - 1)
            self._stream.write("\r\033[K" + colorize(DIM, text))
            self._stream.flush()
            self._visible = True
            self._frame = (self._frame + 1) % len(SPINNER_FRAMES)
            if self._stop.wait(SPINNER_INTERVAL_S):
                return


def print_account(
    layout: Layout, name: str, aliases=(), live: bool = False, note: str = ""
) -> None:
    """One account header: liveness dot, label, aliases, optional state word."""
    segments = [
        (DOT_LIVE if live else DOT_DORMANT, GREEN if live else DIM),
        (" ", None),
        (name, BOLD if live else None),
    ]
    if aliases:
        segments.append((f" ({', '.join(aliases)})", DIM))
    if note:
        segments.append((f" · {note}", DIM))
    emit(segments, layout.width - 1)


def print_meter(layout: Layout, label: str, percent: float, reset_dt) -> None:
    color = GREEN if percent < 70 else YELLOW if percent < 90 else RED
    filled = max(0, min(layout.bar_w, round(percent / 100 * layout.bar_w)))
    segments = [
        (" " * INDENT, None),
        (fit(label, layout.label_w), None),
        (" " * GAP, None),
        (BAR_FULL * filled, color),
        (BAR_EMPTY * (layout.bar_w - filled), DIM),
        (" " * GAP, None),
        (f"{percent:>3.0f}%", color),
    ]
    if layout.reset_w and reset_dt is not None:
        segments += [
            (" " * GAP, None),
            (fmt_reset(reset_dt, layout.reset_w >= RESET_W_LONG), DIM),
        ]
    emit(segments, layout.width - 1)


def print_detail(layout: Layout, label: str, value: str) -> None:
    """A row with no meter (dollar spend, credits), on the same columns."""
    emit(
        [
            (" " * INDENT, None),
            (fit(label, layout.label_w), None),
            (" " * GAP, None),
            (value, DIM),
        ],
        layout.width - 1,
    )


def print_hint(layout: Layout, text: str) -> None:
    emit([(" " * INDENT, None), (text, DIM)], layout.width - 1)


def open_block(spinner) -> None:
    """Retire the spinner line, then open a block with its blank separator.

    The single place that knows stdout is about to be written to. Every block
    starts with a blank line and none ends with one, so piping stays clean and
    a bare `seat` gets air under the prompt — and routing that one print through
    here means a spinner frame can never end up spliced into a meter row.
    """
    spinner.hide()
    print()


def report(spinner, layout: Layout, as_json: bool, name, akas, live, state, hint):
    """An account that has no bars to draw — expired, or the fetch failed.

    Rendered inline in the human view so the blocks stay in order and the table
    keeps no holes; under --json the only reader is a machine, and the one
    stream it does not parse is stderr.
    """
    if as_json:
        print(f"seat: {name}: {state} — {hint}", file=sys.stderr)
        return
    open_block(spinner)
    print_account(layout, name, akas, live, state)
    print_hint(layout, hint)


def fmt_reset(dt, long: bool) -> str:
    """Time to reset: a countdown, plus the wall clock when there is room."""
    secs = int((dt - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
    if secs <= 0:
        return "resetting"
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    mins = rem // 60
    if days:
        countdown = f"{days}d{hours}h"
    elif hours:
        countdown = f"{hours}h{mins:02d}m"
    else:
        countdown = f"{mins}m"
    if not long:
        return f"in {countdown}"
    # Past a day the weekday carries more than the date does, and the countdown
    # sitting beside it removes the only ambiguity a bare weekday would have.
    clock = dt.astimezone().strftime("%H:%M" if secs < 86400 else "%a %H:%M")
    return f"in {countdown} · {clock}"


# MARK: - Usage / endpoints


def http_get_json(url: str, headers: dict) -> dict:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=USAGE_TIMEOUT_S) as resp:
        return json.load(resp)


def try_fetch(fetch, cred: dict):
    """(data, error) for one account — one account's failure is never fatal."""
    try:
        return fetch(cred), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code} {e.reason}"
    except Exception as e:  # noqa: BLE001 — surface any network failure per account
        return None, str(e)


def fetch_claude_usage(cred: dict) -> dict:
    return http_get_json(
        "https://api.anthropic.com/api/oauth/usage",
        {
            "Authorization": f"Bearer {cred['access']}",
            "anthropic-beta": "oauth-2025-04-20",
            "Accept": "application/json",
            "User-Agent": "claude-code/2.1.69",
        },
    )


CLAUDE_ROW_LABELS = {"session": "5h", "weekly_all": "weekly"}


def render_claude_usage(layout: Layout, data: dict) -> None:
    for lim in data.get("limits", []):
        kind = lim.get("kind", "?")
        label = CLAUDE_ROW_LABELS.get(kind)
        if label is None:
            scope = (lim.get("scope") or {}).get("model") or {}
            model = scope.get("display_name") or kind
            # On a slim label column the model name is the half that carries
            # information: it sits under a `weekly` row either way, and
            # "weekly Sonnet" truncated is exactly the wrong half to keep.
            if lim.get("group") == "weekly" and layout.label_w >= LABEL_W:
                label = f"weekly {model}"
            else:
                label = model
        reset_dt = None
        if lim.get("resets_at"):
            reset_dt = datetime.datetime.fromisoformat(lim["resets_at"])
        print_meter(layout, label, lim.get("percent") or 0, reset_dt)
    extra = data.get("extra_usage") or {}
    if extra.get("is_enabled"):
        scale = 10 ** extra.get("decimal_places", 2)
        used = extra.get("used_credits", 0) / scale
        limit = extra.get("monthly_limit", 0) / scale
        print_detail(layout, "extra", f"${used:.2f} / ${limit:.2f}")


def fetch_codex_usage(cred: dict) -> dict:
    headers = {
        "Authorization": f"Bearer {cred['access']}",
        "Accept": "application/json",
        "User-Agent": "seat",
    }
    if cred.get("accountId"):
        headers["ChatGPT-Account-Id"] = cred["accountId"]
    return http_get_json("https://chatgpt.com/backend-api/wham/usage", headers)


def window_label(seconds: int) -> str:
    if seconds >= 6 * 86400:
        return "weekly"
    return f"{seconds // 3600}h"


def render_codex_usage(layout: Layout, data: dict) -> None:
    rl = data.get("rate_limit") or {}
    for key in ("primary_window", "secondary_window"):
        win = rl.get(key)
        if not win:
            continue
        reset_dt = None
        if win.get("reset_at"):
            reset_dt = datetime.datetime.fromtimestamp(
                win["reset_at"], tz=datetime.timezone.utc
            )
        print_meter(
            layout,
            window_label(win.get("limit_window_seconds", 0)),
            win.get("used_percent") or 0,
            reset_dt,
        )
    credits = (data.get("rate_limit_reset_credits") or {}).get("available_count")
    if credits:
        print_detail(layout, "credits", str(credits))


# MARK: - Usage / command


def claude_accounts(auth: dict, store: dict) -> list:
    """Every Claude account as (label, cred, from_auth) — auth.json's first.

    pi only ever refreshes auth.json, so whatever sits there is the freshest
    copy of whichever account it belongs to: that account renders from it and
    the rest render from the store — a dormant token stays usable until its
    TTL (~8h) outlives the last switch away. The owner comes from attribute(),
    never from `active`. A credential attribute() cannot name keeps label None
    ("unidentified" is display only, so no real profile can collide with it)
    and hides no stored profile behind the guess. Without stored profiles this
    degrades to one unlabeled account.
    """
    cur = auth.get(PROVIDER)
    profiles = store["profiles"]
    if not profiles:
        return [(None, cur, True)] if cur else []
    accounts = []
    cur_label = attribute(cur, store)[0] if cur else None
    if cur:
        accounts.append((cur_label, cur, True))
    for label, cred in profiles.items():
        if label != cur_label:
            accounts.append((label, cred, False))
    return accounts


def cmd_usage(args) -> None:
    flags, rest = take_flags(args, {"--json"})
    if rest:
        die("usage: seat usage [--json]", EXIT_USAGE)
    as_json = "--json" in flags

    store = load_store()
    auth = load_auth()
    cur = auth.get(PROVIDER)
    exp = (cur or {}).get("expires")
    # The usage endpoint, like the identity one, answers only for a live access
    # token, so a provably expired live credential gets pi's one safe refresh
    # up front. Proven expiry only: access_is_live() calls a missing `expires`
    # dead — the safe direction for a switch, but here it would spend a
    # `pi auth check` run on every invocation; without the field the GET is
    # simply attempted and a dead token surfaces as its HTTP error.
    # Dormant profiles cannot be refreshed without switching; they get a hint.
    if cur and isinstance(exp, (int, float)) and exp / 1000 <= time.time():
        auth = refresh_through_pi(auth, "its usage cannot be fetched")
    codex = auth.get("openai-codex")
    # claude_accounts() is where attribute() asks the server whose credential
    # auth.json holds, and that answer gates every label below it — so this is
    # the wait that happens before anything can be drawn.
    spinner = Spinner(not as_json)
    spinner.step("identifying the live account")
    accounts = claude_accounts(auth, store)
    if not accounts and not codex:
        die(f"no credentials in {AUTH_PATH} — run /login in pi first")

    now_ms = time.time() * 1000
    layout = term_layout()
    results = {}
    failed = False

    has_profiles = bool(store["profiles"])
    profile_usage = {}
    unattributed = None
    active_label = None
    for label, cred, from_auth in accounts:
        name = label or ("unidentified" if has_profiles else "Claude")
        akas = sorted(a for a, l in store["aliases"].items() if l == label)
        if cred.get("expires") and cred["expires"] < now_ms:
            if from_auth:
                # refresh_through_pi already said on stderr why it is still dead.
                hint = "pi could not refresh it — log in to that account again"
                failed = True
            else:
                # A dormant profile going stale is normal, not an error: pi
                # only ever refreshes the credential in auth.json.
                hint = f"`seat {label}` then one pi run refreshes it"
            report(
                spinner, layout, as_json, name, akas, from_auth,
                "token expired", hint,
            )
            continue
        spinner.step(f"checking {name}")
        data, err = try_fetch(fetch_claude_usage, cred)
        if data is None:
            failed = True
            report(
                spinner, layout, as_json, name, akas, from_auth, "unavailable", err
            )
            continue
        if not as_json:
            open_block(spinner)
            print_account(layout, name, akas, from_auth)
            render_claude_usage(layout, data)
        if label is not None:
            profile_usage[label] = data
            if from_auth:
                active_label = label
        elif has_profiles:
            # Unattributable: worth showing, but never keyed like a profile —
            # a real label named "unidentified" must not collide with it.
            unattributed = data
        else:
            results["anthropic"] = data
    if profile_usage or unattributed is not None:
        anthropic = {"active": active_label, "profiles": profile_usage}
        if unattributed is not None:
            anthropic["unattributed"] = unattributed
        results["anthropic"] = anthropic

    if codex:
        if codex.get("expires") and codex["expires"] < now_ms:
            failed = True
            report(
                spinner,
                layout,
                as_json,
                "Codex",
                (),
                True,
                "token expired",
                "run pi once to refresh it",
            )
        else:
            spinner.step("checking Codex")
            data, err = try_fetch(fetch_codex_usage, codex)
            if data is None:
                failed = True
                report(
                    spinner, layout, as_json, "Codex", (), True, "unavailable", err
                )
            else:
                if not as_json:
                    open_block(spinner)
                    plan = str(data.get("plan_type") or "")
                    print_account(layout, "Codex", (), True, plan)
                    render_codex_usage(layout, data)
                results["openai-codex"] = data

    if as_json:
        print(json.dumps(results, indent=2))
    if failed:
        sys.exit(EXIT_FAIL)


# MARK: - Commands


def fmt_expiry(cred) -> str:
    exp = cred.get("expires")
    if not isinstance(exp, (int, float)):
        return "unknown expiry"
    dt = datetime.datetime.fromtimestamp(exp / 1000)
    state = "valid" if exp / 1000 > time.time() else "expired"
    return f"access {state}, expires {dt:%Y-%m-%d %H:%M}"


def fmt_identity(ident) -> str:
    """Last-seen organization, for display only — an org can be renamed and a
    seat retiered, so this never decides anything."""
    if not isinstance(ident, dict) or not ident.get("account_uuid"):
        return ""
    who = ident.get("organization_name") or ident.get("account_email") or "personal"
    tier = ident.get("seat_tier")
    return f" — {who}" + (f" / {tier}" if tier else "")


def cmd_status(args) -> None:
    flags, rest = take_flags(args, {"--plain"})
    if rest:
        die("usage: seat status [--plain]", EXIT_USAGE)
    store = load_store()
    profiles = store["profiles"]
    active = store["active"]

    if "--plain" in flags:
        for label, cred in profiles.items():
            exp = cred.get("expires")
            exp = str(int(exp)) if isinstance(exp, (int, float)) else "-"
            akas = ",".join(a for a, l in store["aliases"].items() if l == label)
            print(
                f"{label}\t{'active' if label == active else '-'}"
                f"\t{exp}\t{akas or '-'}"
            )
        return

    print(f"active: {active or '(none)'}")
    cur = load_auth().get(PROVIDER)
    if not cur:
        print("auth.json anthropic: (not logged in)")
    else:
        # Only the free half of attribution: naming the owner for certain can
        # cost a network round-trip, and `status` should never pay one.
        exact = [l for l, c in profiles.items() if c == cur]
        if len(exact) == 1 and exact[0] != active:
            note = f" — belongs to '{exact[0]}', not the recorded active"
        elif exact:
            note = ""
        else:
            note = " — rotated since seat last wrote it; owner unconfirmed offline"
        print(f"auth.json anthropic: {fmt_expiry(cur)}{note}")
    if profiles:
        print("profiles:")
        for label, cred in profiles.items():
            akas = [a for a, l in store["aliases"].items() if l == label]
            aka = f" ({', '.join(akas)})" if akas else ""
            who = fmt_identity(store["identities"].get(label))
            print(
                f"  {'*' if label == active else ' '} {label}{aka}: "
                f"{fmt_expiry(cred)}{who}"
            )
    else:
        print("profiles: (none — use `seat save <label>` first)")

    names = list(profiles) + [a for a in store["aliases"] if a not in profiles]
    shadowed = [n for n in names if n in COMMANDS or n.startswith("-")]
    if shadowed:
        print(
            f"seat: shadowed by a command name: {', '.join(shadowed)} — reach "
            f"profiles with `seat use <label>` or rename them",
            file=sys.stderr,
        )
    dangling = [a for a, l in store["aliases"].items() if l not in profiles]
    if dangling:
        print(
            f"seat: aliases pointing at a missing profile: {', '.join(dangling)} "
            f"— `seat rm <alias>` drops them",
            file=sys.stderr,
        )


def is_swap(store: dict, label: str, cred: dict, identity) -> bool:
    """True when saving `label` would stamp a *different* account onto it.

    This used to wave through any save onto `active`, reasoning that re-saving
    the active profile is just a token refresh. A `/login` makes `active` a lie,
    and `seat save <active>` then overwrote that profile with a foreign account
    and reported "updated". Matching refresh tokens is no better: pi rotates them
    on every refresh, so equality is absent exactly when the profile is healthy.

    Pure by design — `identity` is fetched once by the caller, outside the lock.
    A failed lookup leaves it None, which reads as "cannot prove" and asks.
    """
    stored = store["profiles"].get(label)
    if stored is None or stored == cred:
        return False
    return not same_identity(store["identities"].get(label), identity)


def cmd_save(args) -> None:
    names, args = split_alias_flags(args)
    flags, rest = take_flags(args, {"--force", "--no-input"})
    if len(rest) != 1:
        die("usage: seat save <label> [-a <alias>] [--force] [--no-input]", EXIT_USAGE)
    label = validate_label(rest[0])

    # Confirm before locking: an interactive prompt must not hold a lock that
    # pi would declare stale while the user is reading it.
    store = load_store()
    if label in store["aliases"]:
        die(
            f"'{label}' is an alias for '{store['aliases'][label]}'; "
            f"`seat rm {label}` first, or pick another label",
            EXIT_USAGE,
        )
    for name in names:
        validate_alias(store, name, label)  # fail before any prompt
    auth = load_auth()
    cred = auth.get(PROVIDER)
    # Unlike a switch, a save always wants the identity recorded, so a profile
    # already holding this credential verbatim is no reason to skip the refresh.
    if cred and not access_is_live(cred):
        auth = refresh_through_pi(auth)
    snapshot = current_credential(auth)
    try:
        identity = fetch_identity(snapshot.get("access"))
        identity_why = None
    except IdentityError as e:
        identity, identity_why = None, str(e)

    approved = False
    if is_swap(store, label, snapshot, identity):
        if not confirm(
            f"'{label}' holds a different account's credential; overwriting it "
            f"cannot be undone without logging in to that account again.\ncontinue?",
            flags,
        ):
            die("aborted")
        approved = True

    with AuthLock(AUTH_PATH):
        cur = current_credential(load_auth())
        store = load_store()
        # The identity was resolved against `snapshot`; if auth.json moved on,
        # it describes a credential we are no longer about to store.
        if cur != snapshot:
            die("auth.json changed while saving; re-run `seat save`")
        if not approved and is_swap(store, label, cur, identity):
            die("profiles changed while confirming; re-run `seat save`")
        if label in store["aliases"]:
            die(f"'{label}' became an alias meanwhile; re-run `seat save`")
        existed = label in store["profiles"]
        store["profiles"][label] = cur
        store["active"] = label
        # Never leave a stale identity attached to a credential it no longer
        # describes: unproven is recoverable, wrong is not.
        if identity:
            store["identities"][label] = identity
        else:
            store["identities"].pop(label, None)
        alias_msgs = apply_aliases(store, label, names)
        write_json_600(PROFILES_PATH, store)
    print(f"{'updated' if existed else 'saved'} profile '{label}' (now active)")
    if identity_why:
        print(
            f"seat: stored without an identity ({identity_why}); until one is "
            f"recorded this profile can only be recognised while its credential "
            f"is unchanged",
            file=sys.stderr,
        )
    for m in alias_msgs:
        print(m)


def cmd_rm(args) -> None:
    flags, rest = take_flags(args, {"--force", "--no-input"})
    if len(rest) != 1:
        die("usage: seat rm <label>|<alias> [--force] [--no-input]", EXIT_USAGE)
    name = rest[0]
    store = load_store()
    if name not in store["profiles"]:
        if name not in store["aliases"]:
            unknown_profile(name, store)
        with AuthLock(AUTH_PATH):
            store = load_store()
            target = store["aliases"].pop(name, None)
            if target is None:
                die(f"alias '{name}' is already gone")
            write_json_600(PROFILES_PATH, store)
        print(f"removed alias '{name}' (was -> '{target}')")
        return
    if not confirm(
        f"delete profile '{name}'? its credential cannot be restored without "
        f"logging in to that account again.",
        flags,
    ):
        die("aborted")

    with AuthLock(AUTH_PATH):
        store = load_store()
        if name not in store["profiles"]:
            die(f"profile '{name}' is already gone")
        del store["profiles"][name]
        store["identities"].pop(name, None)
        dropped = [a for a, l in store["aliases"].items() if l == name]
        for a in dropped:
            del store["aliases"][a]
        was_active = store["active"] == name
        if was_active:
            store["active"] = None
        write_json_600(PROFILES_PATH, store)
    msg = f"deleted profile '{name}'"
    if dropped:
        msg += f" and alias{'es' if len(dropped) > 1 else ''} {', '.join(dropped)}"
    if was_active:
        msg += (
            " — it was active; auth.json still holds that credential, "
            "so `seat save <label>` can re-store it"
        )
    print(msg)


def cmd_rename(args) -> None:
    _, rest = take_flags(args, set())
    if len(rest) != 2:
        die("usage: seat rename <old> <new>", EXIT_USAGE)
    old, new = rest[0], validate_label(rest[1])
    with AuthLock(AUTH_PATH):
        store = load_store()
        profiles = store["profiles"]
        if old not in profiles:
            unknown_profile(old, store)
        if new in profiles:
            die(f"profile '{new}' already exists; `seat rm {new}` first", EXIT_USAGE)
        if new in store["aliases"]:
            die(
                f"'{new}' is an alias for '{store['aliases'][new]}'; "
                f"`seat rm {new}` first",
                EXIT_USAGE,
            )
        profiles[new] = profiles.pop(old)
        if old in store["identities"]:
            store["identities"][new] = store["identities"].pop(old)
        for a, l in store["aliases"].items():
            if l == old:
                store["aliases"][a] = new
        if store["active"] == old:
            store["active"] = new
        write_json_600(PROFILES_PATH, store)
    print(f"renamed '{old}' to '{new}'")


def do_switch(target: str, alias_names=()) -> None:
    # Resolve the owner before taking the lock: attribution can cost a network
    # round-trip, and AuthLock is only safe while it stays milliseconds wide.
    store = load_store()
    label = resolve_target(store, target)
    if label not in store["profiles"]:
        unknown_profile(target, store)
    auth = load_auth()
    cred = auth.get(PROVIDER)
    # Rotated by pi and then left to expire past its own lifetime: byte-equality
    # has nothing to match and the endpoint will not answer for a dead token, so
    # both paths to the owner are shut. One delegated refresh reopens the second.
    if cred and not stored_verbatim(cred, store) and not access_is_live(cred):
        auth = refresh_through_pi(auth)
    snapshot = auth.get(PROVIDER)
    prev_active = store["active"]
    owner = attribute_or_die(snapshot, store) if snapshot else None

    with AuthLock(AUTH_PATH):
        auth = load_auth()
        store = load_store()
        profiles = store["profiles"]
        # Everything decided above was decided about this exact snapshot.
        if auth.get(PROVIDER) != snapshot:
            die("auth.json changed while resolving its owner; re-run the switch")
        if resolve_target(store, target) != label or label not in profiles:
            die("the store changed while resolving the target; re-run the switch")
        if owner is not None and owner not in profiles:
            die(f"profile '{owner}' disappeared while resolving; re-run the switch")
        alias_msgs = apply_aliases(store, label, alias_names)
        # pi rotates the live credential in place, so auth.json holds a newer
        # copy than the store does — and the old one is dead, not merely stale.
        # It has to reach its real owner, which is rarely `active` and is never
        # assumed to be.
        if owner is not None:
            profiles[owner] = snapshot
        switched = owner != label
        if switched:
            auth[PROVIDER] = profiles[label]
        store["active"] = label
        # profiles.json first. Between these two writes it holds the only copy
        # of the rotated credential auth.json is about to lose; crash after the
        # other order and that credential is gone for good.
        write_json_600(PROFILES_PATH, store)
        if switched:
            write_json_600(AUTH_PATH, auth)
    if owner is not None and owner != prev_active:
        print(
            f"seat: auth.json's credential belongs to '{owner}', not the "
            f"recorded active '{prev_active or '(none)'}' — corrected",
            file=sys.stderr,
        )
    if switched:
        print(f"switched to '{label}' — running pi sessions apply it on their next request")
    else:
        print(f"already on '{label}'")
    for m in alias_msgs:
        print(m)


def cmd_whoami(args) -> None:
    """Name the profile auth.json's credential actually belongs to.

    The one question `status` cannot answer for free, kept as its own command
    for scripts and prompts; `usage` shares attribute() in-process instead of
    carrying a second copy of the endpoint contract.
    """
    flags, rest = take_flags(args, {"--plain"})
    if rest:
        die("usage: seat whoami [--plain]", EXIT_USAGE)
    store = load_store()
    label, why = attribute(current_credential(load_auth()), store)
    if label is None:
        die(f"cannot attribute the credential in auth.json ({why})")
    if "--plain" in flags:
        print(label)
        return
    aka = [a for a, l in store["aliases"].items() if l == label]
    print(
        f"{label}{f' ({chr(44).join(aka)})' if aka else ''}"
        f"{fmt_identity(store['identities'].get(label))}"
    )
    if store["active"] != label:
        print(
            f"seat: the store still records '{store['active'] or '(none)'}' as "
            f"active; the next switch corrects it",
            file=sys.stderr,
        )


def cmd_use(args) -> None:
    names, args = split_alias_flags(args)
    _, rest = take_flags(args, set())
    if len(rest) != 1:
        die("usage: seat [use] <label>|<alias> [-a <alias>]", EXIT_USAGE)
    do_switch(rest[0], names)


def cmd_help(args) -> None:
    print(__doc__.strip())


# Single source of truth: dispatch and the reserved-label check read this table,
# so a new command can never silently shadow a label the check forgot about.
COMMANDS = {
    "help": cmd_help,
    "rename": cmd_rename,
    "rm": cmd_rm,
    "save": cmd_save,
    "status": cmd_status,
    "use": cmd_use,
    "usage": cmd_usage,
    "whoami": cmd_whoami,
}


def main() -> None:
    args = sys.argv[1:]
    if any(a in ("-h", "--help") for a in args):
        print(__doc__.strip())
        return
    if args and args[0] == "--version":
        print(f"seat {VERSION}")
        return
    if not args:
        cmd_usage([])
        return

    handler = COMMANDS.get(args[0])
    if handler:
        handler(args[1:])
    else:
        # Shorthand: `seat <label>|<alias> [-a <alias>]`; flags may sit anywhere.
        cmd_use(args)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
