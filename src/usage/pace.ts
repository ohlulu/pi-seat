/**
 * Burn-rate pacing for a usage meter (REQ-011).
 *
 * A meter's percentage answers "how much is gone"; on its own it cannot say
 * whether that is a problem. 39% of a weekly window is comfortable on day five
 * and a blow-out on day two. Pace closes that gap by projecting the current
 * burn rate to the end of the reset window: `projected = percent / elapsed
 * fraction`, which lands over 100% exactly when `percent` is running ahead of
 * elapsed time.
 *
 * Ported from openusage's `Pace.swift` (MIT, see NOTICE) — the thresholds, the
 * minimum-elapsed floor and the near-empty distrust guard are its design, not
 * ours. The one deliberate difference is noted at `DISTRUST_BELOW_PERCENT`.
 *
 * Pure and clock-injected, like the rest of `src/usage`: no I/O, no colors.
 * `render.ts` maps a verdict onto the bar color and owns the fallback when
 * there is no verdict.
 */

/** Claude's rolling session window. The usage payload carries no duration —
 * see `claudeLimitPeriodMs`. */
export const SESSION_PERIOD_MS = 5 * 3_600_000;
/** Claude's weekly windows, and any `group: "weekly"` limit. */
export const WEEK_PERIOD_MS = 7 * 86_400_000;

/** Where the current burn rate lands the meter at the end of its window. */
export type PaceVerdict =
	/** Projected to finish with at least 10% of the quota to spare. */
	| "ahead"
	/** Projected to land inside the last 10% — cutting it close. */
	| "onTrack"
	/** Projected to blow past the limit before the window resets. */
	| "behind";

/** Projected usage over the whole window, as a percentage of the quota. */
export function projectedPercent(percent: number, elapsedMs: number, periodMs: number): number {
	return (percent * periodMs) / elapsedMs;
}

/**
 * How far into the window a projection becomes meaningful: 1% of the period,
 * never under a minute. Dividing a whole-percent meter by a few seconds of
 * elapsed time projects noise, not a burn rate.
 */
export function minimumElapsedMs(periodMs: number): number {
	return Math.max(60_000, periodMs * 0.01);
}

/**
 * Below this share of the quota, no projection is trusted at all. One percent
 * of resolution against a nearly-empty meter swings the projection across the
 * whole scale, and the honest reading of "95% still left" is that there is
 * nothing to say yet.
 *
 * openusage applies this guard only to its red state, letting amber through on
 * a near-empty meter. It has room for explanatory copy next to the bar; here
 * the color is the entire message, so a spurious amber misleads in the same
 * way a spurious red does, only more quietly. The guard covers both.
 */
export const DISTRUST_BELOW_PERCENT = 5;

/**
 * The pace verdict for one meter, or `null` when there is no trustworthy
 * signal — window not started, already reset, too early to project, or too
 * little spent to project from. `null` means "say nothing"; the caller falls
 * back to reading the absolute level.
 *
 * `percent` is the share of the quota already used (0–100), so the limit is
 * always 100 and no separate quota needs to be known.
 */
export function evaluatePace(
	percent: number,
	resetsAt: Date | null,
	periodMs: number | null,
	now: Date,
): PaceVerdict | null {
	if (resetsAt === null || periodMs === null || periodMs <= 0) return null;

	// Finiteness is checked before any comparison, because NaN slides through
	// all of them: every guard below is a `<` or `>=`, and each one is false for
	// NaN, so an unparsable `resets_at` would fall past every gate and land on
	// the default verdict — painting a meter red on the strength of a malformed
	// timestamp. The usage payload is cast, not validated, so this is reachable
	// from the wire. Infinity gets here the same way, via a `reset_at` or
	// `limit_window_seconds` large enough to overflow the conversion to ms.
	const resetMs = resetsAt.getTime();
	if (!Number.isFinite(resetMs) || !Number.isFinite(periodMs)) return null;
	const elapsedMs = now.getTime() - (resetMs - periodMs);
	if (!Number.isFinite(elapsedMs)) return null;

	if (elapsedMs < minimumElapsedMs(periodMs)) return null;
	if (now.getTime() >= resetMs) return null;

	if (percent <= 0) return "ahead";
	// An exhausted quota is the one case that needs no projection.
	if (percent >= 100) return "behind";
	if (percent < DISTRUST_BELOW_PERCENT) return null;

	const projected = projectedPercent(percent, elapsedMs, periodMs);
	if (projected <= 90) return "ahead";
	if (projected <= 100) return "onTrack";
	return "behind";
}

/**
 * The window length behind a Claude limit, or `null` when it cannot be told.
 *
 * The `/api/oauth/usage` payload carries no duration field — verified against
 * a live response, whose `limits[]` entries hold only `kind`, `group`,
 * `percent`, `severity`, `resets_at`, `scope` and `is_active`. The durations
 * are therefore inferred from the group, exactly as openusage does. If
 * Anthropic ever changes a window length, this mapping is the single place
 * that has to follow.
 *
 * `group` is what live payloads carry (`session`, `weekly`); `kind` is the
 * fallback for the older shape the golden fixtures pin, where a weekly limit
 * arrives as `weekly_all` with no group. An unrecognized limit returns `null`
 * and keeps its absolute coloring rather than guessing a window.
 */
export function claudeLimitPeriodMs(limit: { kind?: string; group?: string }): number | null {
	const key = limit.group ?? limit.kind ?? "";
	if (key === "session") return SESSION_PERIOD_MS;
	if (key.startsWith("weekly")) return WEEK_PERIOD_MS;
	return null;
}
