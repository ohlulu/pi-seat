import { describe, expect, test } from "bun:test";
import { planLayout } from "../../src/usage/layout.ts";
import {
	claudeLimitPeriodMs,
	evaluatePace,
	SESSION_PERIOD_MS,
	WEEK_PERIOD_MS,
	type PaceVerdict,
} from "../../src/usage/pace.ts";
import {
	GREEN,
	RED,
	YELLOW,
	meterColor,
	renderClaudeUsage,
	renderCodexUsage,
	type ClaudeUsage,
	type CodexUsage,
	type RenderOptions,
} from "../../src/usage/render.ts";

const NOW = new Date("2026-01-15T12:00:00Z");
const OPTS: RenderOptions = { color: true, now: () => NOW, timeZone: "UTC" };

/** A window whose reset is placed so that exactly `fraction` of it has elapsed. */
function resetsAfterElapsed(periodMs: number, fraction: number): Date {
	return new Date(NOW.getTime() + periodMs * (1 - fraction));
}

function verdict(percent: number, elapsedFraction: number, periodMs = WEEK_PERIOD_MS): PaceVerdict | null {
	return evaluatePace(percent, resetsAfterElapsed(periodMs, elapsedFraction), periodMs, NOW);
}

describe("evaluatePace (REQ-011)", () => {
	test("burning faster than the clock is behind", () => {
		// 39% spent with 30% of the week gone projects to ~127%.
		expect(verdict(39, 0.3)).toBe("behind");
		expect(verdict(50, 0.25)).toBe("behind");
	});

	test("projected to land inside the last 10% is onTrack", () => {
		// 47.5% at the halfway mark projects to 95% — a 5% cushion.
		expect(verdict(47.5, 0.5)).toBe("onTrack");
		// The boundaries: 90% projected is still ahead, just over it is not.
		expect(verdict(45, 0.5)).toBe("ahead");
		expect(verdict(45.5, 0.5)).toBe("onTrack");
		expect(verdict(50, 0.5)).toBe("onTrack");
		expect(verdict(50.5, 0.5)).toBe("behind");
	});

	test("burning slower than the clock is ahead, however much is gone", () => {
		// Level alone would call 85% critical; with 95% of the window gone it
		// is projected to finish with ~10% to spare, which is not a problem.
		expect(verdict(85, 0.95)).toBe("ahead");
		expect(verdict(13, 0.274, SESSION_PERIOD_MS)).toBe("ahead");
	});

	test("an untouched meter is ahead and an exhausted one is behind", () => {
		expect(verdict(0, 0.5)).toBe("ahead");
		expect(verdict(100, 0.99)).toBe("behind");
		// Exhausted outranks the near-empty distrust guard by construction.
		expect(verdict(100, 0.999)).toBe("behind");
	});

	test("no window means no verdict", () => {
		expect(evaluatePace(50, null, WEEK_PERIOD_MS, NOW)).toBeNull();
		expect(evaluatePace(50, resetsAfterElapsed(WEEK_PERIOD_MS, 0.5), null, NOW)).toBeNull();
		expect(evaluatePace(50, resetsAfterElapsed(WEEK_PERIOD_MS, 0.5), 0, NOW)).toBeNull();
	});

	test("too early in the window to project", () => {
		// The floor is 1% of the period, never under a minute.
		expect(verdict(50, 0.009)).toBeNull();
		expect(verdict(50, 0.011)).toBe("behind");
		// A five-hour window's 1% is 3 minutes, so the minute floor does not bind.
		expect(evaluatePace(50, new Date(NOW.getTime() + SESSION_PERIOD_MS), SESSION_PERIOD_MS, NOW)).toBeNull();
	});

	test("a window that has already reset says nothing", () => {
		expect(evaluatePace(50, new Date(NOW.getTime() - 1000), WEEK_PERIOD_MS, NOW)).toBeNull();
		expect(evaluatePace(50, NOW, WEEK_PERIOD_MS, NOW)).toBeNull();
	});

	test("a nearly-empty meter is distrusted, loud verdict or quiet", () => {
		// 4% spent in the first 2% of the week projects to 200%, which is noise
		// at whole-percent resolution — 96% of the quota is still there.
		expect(verdict(4, 0.02)).toBeNull();
		// Deliberately wider than openusage's guard, which lets amber through
		// here: color is this report's only channel, so a spurious amber
		// misleads the same way a spurious red does.
		expect(verdict(4.8, 0.05)).toBeNull();
		expect(verdict(5, 0.02)).toBe("behind");
	});
});

describe("claudeLimitPeriodMs", () => {
	test("live payloads carry the group", () => {
		expect(claudeLimitPeriodMs({ kind: "session", group: "session" })).toBe(SESSION_PERIOD_MS);
		expect(claudeLimitPeriodMs({ kind: "weekly_all", group: "weekly" })).toBe(WEEK_PERIOD_MS);
		expect(claudeLimitPeriodMs({ kind: "weekly_scoped", group: "weekly" })).toBe(WEEK_PERIOD_MS);
	});

	test("the older shape falls back to the kind", () => {
		expect(claudeLimitPeriodMs({ kind: "session" })).toBe(SESSION_PERIOD_MS);
		expect(claudeLimitPeriodMs({ kind: "weekly_all" })).toBe(WEEK_PERIOD_MS);
		expect(claudeLimitPeriodMs({ kind: "weekly_sonnet" })).toBe(WEEK_PERIOD_MS);
	});

	test("an unrecognized limit gets no window rather than a guessed one", () => {
		expect(claudeLimitPeriodMs({ kind: "nimbus_quill" })).toBeNull();
		expect(claudeLimitPeriodMs({})).toBeNull();
	});
});

describe("meterColor (REQ-011)", () => {
	test("the pace verdict drives the color when there is one", () => {
		const week = (percent: number, fraction: number) =>
			meterColor(percent, resetsAfterElapsed(WEEK_PERIOD_MS, fraction), WEEK_PERIOD_MS, NOW);
		expect(week(39, 0.3)).toBe(RED);
		expect(week(47.5, 0.5)).toBe(YELLOW);
		expect(week(20, 0.5)).toBe(GREEN);
	});

	test("without a verdict the absolute thresholds are unchanged", () => {
		// No window at all: the pre-pace 70/90 bands, exactly as before.
		expect(meterColor(69, null, null, NOW)).toBe(GREEN);
		expect(meterColor(70, null, null, NOW)).toBe(YELLOW);
		expect(meterColor(89, null, null, NOW)).toBe(YELLOW);
		expect(meterColor(90, null, null, NOW)).toBe(RED);
		// Same fallback when the window exists but is too young to project.
		expect(meterColor(95, resetsAfterElapsed(WEEK_PERIOD_MS, 0.005), WEEK_PERIOD_MS, NOW)).toBe(RED);
	});

	test("level and pace can disagree, and pace wins", () => {
		// 85% used would be critical by level; projected to spare 10%, it is calm.
		expect(meterColor(85, resetsAfterElapsed(WEEK_PERIOD_MS, 0.95), WEEK_PERIOD_MS, NOW)).toBe(GREEN);
		// 39% used would be calm by level; projected to 127%, it is not.
		expect(meterColor(39, resetsAfterElapsed(WEEK_PERIOD_MS, 0.3), WEEK_PERIOD_MS, NOW)).toBe(RED);
	});
});

describe("provider blocks color by pace", () => {
	const layout = planLayout(100);

	test("Claude infers the window from the limit group", () => {
		// The shape of a live /api/oauth/usage response, replayed against a
		// frozen clock: the session window is under pace, both weekly ones over.
		const usage: ClaudeUsage = {
			limits: [
				{ kind: "session", group: "session", percent: 13, resets_at: resetsAfterElapsed(SESSION_PERIOD_MS, 0.274).toISOString() },
				{ kind: "weekly_all", group: "weekly", percent: 39, resets_at: resetsAfterElapsed(WEEK_PERIOD_MS, 0.307).toISOString() },
				{
					kind: "weekly_scoped",
					group: "weekly",
					scope: { model: { display_name: "Fable" } },
					percent: 49,
					resets_at: resetsAfterElapsed(WEEK_PERIOD_MS, 0.307).toISOString(),
				},
			],
		};
		const [session, weekly, scoped] = renderClaudeUsage(layout, usage, OPTS);
		expect(session).toContain(GREEN);
		expect(weekly).toContain(RED);
		expect(scoped).toContain(RED);
		// Every one of these would have been green under the absolute bands.
		expect(weekly).not.toContain(GREEN);
	});

	test("Codex takes the window length the payload states", () => {
		const usage: CodexUsage = {
			rate_limit: {
				primary_window: {
					limit_window_seconds: 5 * 3600,
					used_percent: 20,
					reset_at: Math.trunc(resetsAfterElapsed(SESSION_PERIOD_MS, 0.5).getTime() / 1000),
				},
				secondary_window: {
					limit_window_seconds: 7 * 86_400,
					used_percent: 91,
					reset_at: Math.trunc(resetsAfterElapsed(WEEK_PERIOD_MS, 0.5).getTime() / 1000),
				},
			},
		};
		const [primary, secondary] = renderCodexUsage(layout, usage, OPTS);
		expect(primary).toContain(GREEN);
		expect(secondary).toContain(RED);
	});

	test("a limit with no reset keeps its absolute color", () => {
		const usage: ClaudeUsage = { limits: [{ kind: "weekly_opus", percent: 70 }] };
		expect(renderClaudeUsage(layout, usage, OPTS)[0]).toContain(YELLOW);
	});
});
