#!/usr/bin/env python3
"""Deterministic golden-fixture generator for seat usage rendering (T022).

Imports the Python seat module from ~/.pi/agent/bin/seat READ-ONLY (must run
while that file still exists), freezes every source of nondeterminism — clock,
timezone, color, spinner — and renders each scenario at every width 2..200 by
driving the module's own layout/render functions with fixed payloads.

Output schema (single JSON document, sorted keys):
  { "meta": {...}, "scenarios": { <scenario>: { <width>: [<stdout line>, ...] } } }

Usage: generate-python-golden.py <output.json>
"""

import contextlib
import datetime as real_datetime
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import time
import types

SEAT_PATH = os.path.expanduser("~/.pi/agent/bin/seat")
FROZEN_NOW = real_datetime.datetime(2026, 1, 15, 12, 0, 0, tzinfo=real_datetime.timezone.utc)
WIDTHS = range(2, 201)


def load_seat_module():
    loader = importlib.machinery.SourceFileLoader("seat_golden", SEAT_PATH)
    spec = importlib.util.spec_from_loader("seat_golden", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class FrozenDateTime(real_datetime.datetime):
    @classmethod
    def now(cls, tz=None):
        return FROZEN_NOW if tz else FROZEN_NOW.replace(tzinfo=None)


def freeze(seat):
    # Timezone: astimezone() in fmt_reset reads the process TZ.
    os.environ["TZ"] = "UTC"
    time.tzset()
    # Clock: fmt_reset calls seat.datetime.datetime.now(...).
    seat.datetime = types.SimpleNamespace(
        datetime=FrozenDateTime,
        timezone=real_datetime.timezone,
    )
    # Color: force the no-color branch regardless of the generator's tty.
    seat.USE_COLOR = False


class DummySpinner:
    def step(self, _label):
        pass

    def hide(self):
        pass


def iso(delta_seconds):
    return (FROZEN_NOW + real_datetime.timedelta(seconds=delta_seconds)).isoformat()


def epoch(delta_seconds):
    return int((FROZEN_NOW + real_datetime.timedelta(seconds=delta_seconds)).timestamp())


CLAUDE_PAYLOAD = {
    "limits": [
        {"kind": "session", "percent": 42, "resets_at": iso(2 * 3600 + 31 * 60)},
        {"kind": "weekly_all", "percent": 63, "resets_at": iso(3 * 86400 + 2 * 3600)},
        {
            "kind": "weekly_sonnet",
            "group": "weekly",
            "scope": {"model": {"display_name": "Sonnet"}},
            "percent": 88,
            "resets_at": iso(3 * 86400 + 2 * 3600),
        },
    ],
    "extra_usage": {
        "is_enabled": True,
        "used_credits": 12345,
        "monthly_limit": 50000,
        "decimal_places": 2,
    },
}

CLAUDE_BOUNDARIES = {
    "limits": [
        {"kind": "session", "percent": 0, "resets_at": iso(45 * 60)},
        {"kind": "weekly_all", "percent": 100, "resets_at": iso(-60)},
        {"kind": "weekly_opus", "scope": {"model": {"display_name": "Opus"}}, "percent": 70},
    ]
}

CODEX_PAYLOAD = {
    "plan_type": "plus",
    "rate_limit": {
        "primary_window": {
            "limit_window_seconds": 5 * 3600,
            "used_percent": 37,
            "reset_at": epoch(4 * 3600 + 12 * 60),
        },
        "secondary_window": {
            "limit_window_seconds": 7 * 86400,
            "used_percent": 91,
            "reset_at": epoch(6 * 86400 + 23 * 3600),
        },
    },
    "rate_limit_reset_credits": {"available_count": 3},
}


def scenario_claude_live_single(seat, layout):
    seat.print_account(layout, "Claude", (), True)
    seat.render_claude_usage(layout, CLAUDE_PAYLOAD)


def scenario_claude_profiles(seat, layout):
    seat.print_account(layout, "work", ("w",), True)
    seat.render_claude_usage(layout, CLAUDE_PAYLOAD)
    seat.print_account(layout, "personal", (), False)
    seat.render_claude_usage(layout, CLAUDE_BOUNDARIES)


def scenario_cjk_label(seat, layout):
    seat.print_account(layout, "工作用帳號", ("工",), True)
    seat.render_claude_usage(layout, CLAUDE_PAYLOAD)


def scenario_codex_block(seat, layout):
    seat.print_account(layout, "Codex", (), True, str(CODEX_PAYLOAD["plan_type"]))
    seat.render_codex_usage(layout, CODEX_PAYLOAD)


def scenario_expired_dormant(seat, layout):
    seat.report(
        DummySpinner(), layout, False,
        "personal", ("p",), False,
        "token expired", "`seat personal` then one pi run refreshes it",
    )


def scenario_reset_edges(seat, layout):
    seat.print_meter(layout, "5h", 50, FROZEN_NOW + real_datetime.timedelta(minutes=30))
    seat.print_meter(layout, "weekly", 50, FROZEN_NOW + real_datetime.timedelta(hours=5, minutes=7))
    seat.print_meter(layout, "edge", 50, FROZEN_NOW + real_datetime.timedelta(days=2, hours=1))
    seat.print_meter(layout, "past", 50, FROZEN_NOW - real_datetime.timedelta(seconds=30))
    seat.print_meter(layout, "nores", 50, None)


SCENARIOS = {
    "claude_live_single": scenario_claude_live_single,
    "claude_profiles": scenario_claude_profiles,
    "cjk_label": scenario_cjk_label,
    "codex_block": scenario_codex_block,
    "expired_dormant": scenario_expired_dormant,
    "reset_edges": scenario_reset_edges,
}


def capture(seat, fn, width):
    layout = seat.plan_layout(width)
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        fn(seat, layout)
    text = buffer.getvalue()
    return text.split("\n")[:-1] if text.endswith("\n") else text.split("\n")


def main():
    if len(sys.argv) != 2:
        print("usage: generate-python-golden.py <output.json>", file=sys.stderr)
        sys.exit(2)
    seat = load_seat_module()
    freeze(seat)

    scenarios = {}
    for name, fn in SCENARIOS.items():
        scenarios[name] = {str(width): capture(seat, fn, width) for width in WIDTHS}

    document = {
        "meta": {
            "source": "~/.pi/agent/bin/seat",
            "seat_version": getattr(seat, "VERSION", "unknown"),
            "frozen_now": FROZEN_NOW.isoformat(),
            "timezone": "UTC",
            "color": False,
            "widths": [WIDTHS.start, WIDTHS.stop - 1],
        },
        "scenarios": scenarios,
    }
    with open(sys.argv[1], "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=1, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    main()
