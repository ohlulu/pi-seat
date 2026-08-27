/**
 * Usage rendering (REQ-006) — direct port of the Python seat's emit /
 * print_account / print_meter / print_detail / print_hint / fmt_reset and the
 * Claude/Codex block renderers. Pure: every function returns lines; the CLI
 * owns stdout. Behavior parity is pinned by the T025 golden tests.
 */

import { cellClip, cellWidth, fit } from "./cells.ts";
import { GAP, INDENT, LABEL_W, RESET_W_LONG, type Layout } from "./layout.ts";
import { claudeLimitPeriodMs, evaluatePace } from "./pace.ts";

export const BAR_FULL = "█";
export const BAR_EMPTY = "░";
export const DOT_LIVE = "●";
export const DOT_DORMANT = "○";
export const RULE = "─";

export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const RED = "\x1b[31m";
export const YELLOW = "\x1b[33m";
export const GREEN = "\x1b[32m";
export const CYAN = "\x1b[36m";
export const RESET = "\x1b[0m";

export const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const SPINNER_INTERVAL_MS = 80;
export const SPINNER_DELAY_MS = 150;

export interface RenderOptions {
	color: boolean;
	/** Frozen in tests; Date.now in production. */
	now: () => Date;
	/** IANA timezone for the reset wall clock; system zone when omitted. */
	timeZone?: string;
}

export type Segment = readonly [text: string, code: string | undefined];

function colorize(code: string | undefined, text: string, color: boolean): string {
	return code !== undefined && color ? `${code}${text}${RESET}` : text;
}

/** One line of (text, color) segments, clipped so it cannot wrap. Color is
 * applied after clipping: escapes have no display width. */
export function emitLine(segments: readonly Segment[], width: number, color: boolean): string {
	const parts: string[] = [];
	let used = 0;
	for (const [text, code] of segments) {
		const room = width - used;
		if (room <= 0) break;
		const clipped = cellClip(text, room);
		parts.push(colorize(code, clipped, color));
		used += cellWidth(clipped);
	}
	return parts.join("").trimEnd();
}

/**
 * Prepend a fixed-width marker to an already-emitted row. Safe only because
 * the row was laid out at `width - marker cells`: this adds cells to a line
 * that is already at its budget, so the subtraction has to happen upstream.
 */
export function prefixLine(marker: Segment, line: string, color: boolean): string {
	const [text, code] = marker;
	return colorize(code, text, color) + line;
}

/** Python's round(): half rounds to the nearest EVEN integer. */
export function roundHalfEven(value: number): number {
	const floor = Math.floor(value);
	const diff = value - floor;
	if (diff < 0.5) return floor;
	if (diff > 0.5) return floor + 1;
	return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * A reset timestamp off the wire, or `null` when it is missing or unusable.
 *
 * The usage payloads are cast, not validated, so an unparsable `resets_at` or
 * an out-of-range `reset_at` reaches us as an Invalid Date. That is not a
 * cosmetic problem: `fmtReset` hands the value to `Intl.DateTimeFormat`, which
 * throws `RangeError` on a non-finite date and takes the whole report down
 * with it, and on the narrow reset column it prints `in NaNm` instead. Both
 * are older than pace. Rejecting the value here means one unreadable field
 * costs its own column and nothing else — the meter still renders, and
 * `evaluatePace` sees the same `null` every other windowless meter produces.
 */
export function parseResetDate(value: string | number | undefined | null): Date | null {
	if (value === undefined || value === null || value === "") return null;
	const dt = new Date(value);
	return Number.isFinite(dt.getTime()) ? dt : null;
}

/** Time to reset: countdown, plus the wall clock when there is room.
 *
 * `now` is a parameter so a caller that already reads the clock can hand over
 * the same instant instead of sampling it again — see `meterLine`. */
export function fmtReset(dt: Date, long: boolean, options: RenderOptions, now: Date = options.now()): string {
	const secs = Math.trunc((dt.getTime() - now.getTime()) / 1000);
	if (secs <= 0) return "resetting";
	const days = Math.trunc(secs / 86_400);
	let rem = secs % 86_400;
	const hours = Math.trunc(rem / 3600);
	rem %= 3600;
	const mins = Math.trunc(rem / 60);
	let countdown: string;
	if (days) countdown = `${days}d${hours}h`;
	else if (hours) countdown = `${hours}h${String(mins).padStart(2, "0")}m`;
	else countdown = `${mins}m`;
	if (!long) return `in ${countdown}`;
	const clock = formatClock(dt, secs >= 86_400, options.timeZone);
	return `in ${countdown} · ${clock}`;
}

/** %H:%M or %a %H:%M in the target zone, C-locale weekday names. */
function formatClock(dt: Date, withWeekday: boolean, timeZone: string | undefined): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		...(timeZone !== undefined ? { timeZone } : {}),
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		weekday: "short",
	}).formatToParts(dt);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	const hhmm = `${get("hour")}:${get("minute")}`;
	return withWeekday ? `${get("weekday")} ${hhmm}` : hhmm;
}

/** One account header: liveness dot, label, aliases, optional state word. */
export function accountLine(
	layout: Layout,
	name: string,
	aliases: readonly string[],
	live: boolean,
	note: string,
	options: RenderOptions,
): string {
	const segments: Segment[] = [
		[live ? DOT_LIVE : DOT_DORMANT, live ? GREEN : DIM],
		[" ", undefined],
		[name, live ? BOLD : undefined],
	];
	if (aliases.length > 0) segments.push([` (${aliases.join(", ")})`, DIM]);
	if (note) segments.push([` · ${note}`, DIM]);
	return emitLine(segments, layout.width - 1, options.color);
}

/**
 * A section title and the rule under it. The rule spans the same budget every
 * other row is clipped to, so it marks the block's full width without being
 * the one row that overflows.
 */
export function sectionLines(layout: Layout, title: string, options: RenderOptions): string[] {
	const budget = Math.max(0, layout.width - 1);
	return [
		emitLine([[title, BOLD]], budget, options.color),
		emitLine([[RULE.repeat(budget), DIM]], budget, options.color),
	];
}

/**
 * The bar color (REQ-011): the burn-rate verdict when the window supports one,
 * the absolute level when it does not.
 *
 * Pace answers the question the percentage cannot — 39% of a weekly window is
 * calm on day five and a blow-out on day two — so it outranks the level
 * whenever it has something trustworthy to say. Without a window, early in
 * one, or on a nearly-empty meter, `evaluatePace` says nothing and the old
 * absolute thresholds take over unchanged.
 */
export function meterColor(percent: number, resetDt: Date | null, periodMs: number | null, now: Date): string {
	switch (evaluatePace(percent, resetDt, periodMs, now)) {
		case "behind":
			return RED;
		case "onTrack":
			return YELLOW;
		case "ahead":
			return GREEN;
		case null:
			return percent < 70 ? GREEN : percent < 90 ? YELLOW : RED;
	}
}

/**
 * `periodMs` is the meter's reset-window length, which only the provider's
 * renderer knows. Omitting it is not "unknown pace" by accident — it is how a
 * caller with no window asks for plain level coloring.
 */
export function meterLine(
	layout: Layout,
	label: string,
	percent: number,
	resetDt: Date | null,
	options: RenderOptions,
	periodMs: number | null = null,
): string {
	// One clock reading for the whole row. The pace verdict and the countdown
	// describe the same instant, and sampling twice would let a row be coloured
	// against one moment and dated against a later one.
	const now = options.now();
	const color = meterColor(percent, resetDt, periodMs, now);
	const filled = Math.max(0, Math.min(layout.barW, roundHalfEven((percent / 100) * layout.barW)));
	const segments: Segment[] = [
		[" ".repeat(INDENT), undefined],
		[fit(label, layout.labelW), undefined],
		[" ".repeat(GAP), undefined],
		[BAR_FULL.repeat(filled), color],
		[BAR_EMPTY.repeat(layout.barW - filled), DIM],
		[" ".repeat(GAP), undefined],
		[`${formatPercent(percent)}%`, color],
	];
	if (layout.resetW && resetDt !== null) {
		segments.push([" ".repeat(GAP), undefined], [fmtReset(resetDt, layout.resetW >= RESET_W_LONG, options, now), DIM]);
	}
	return emitLine(segments, layout.width - 1, options.color);
}

/** Python f"{percent:>3.0f}" — half-even rounding, right-aligned to 3. */
function formatPercent(percent: number): string {
	return String(roundHalfEven(percent)).padStart(3, " ");
}

/** A row with no meter (dollar spend, credits), on the same columns. */
export function detailLine(layout: Layout, label: string, value: string, options: RenderOptions): string {
	return emitLine(
		[
			[" ".repeat(INDENT), undefined],
			[fit(label, layout.labelW), undefined],
			[" ".repeat(GAP), undefined],
			[value, DIM],
		],
		layout.width - 1,
		options.color,
	);
}

export function hintLine(layout: Layout, text: string, options: RenderOptions): string {
	return emitLine(
		[
			[" ".repeat(INDENT), undefined],
			[text, DIM],
		],
		layout.width - 1,
		options.color,
	);
}

// --- Claude block -----------------------------------------------------------

export const CLAUDE_ROW_LABELS: Record<string, string> = { session: "5h", weekly_all: "weekly" };

export interface ClaudeLimit {
	kind?: string;
	group?: string;
	scope?: { model?: { display_name?: string } };
	percent?: number | null;
	resets_at?: string;
}

export interface ClaudeUsage {
	limits?: ClaudeLimit[];
	extra_usage?: {
		is_enabled?: boolean;
		used_credits?: number;
		monthly_limit?: number;
		decimal_places?: number;
	};
}

export function renderClaudeUsage(layout: Layout, data: ClaudeUsage, options: RenderOptions): string[] {
	const lines: string[] = [];
	for (const lim of data.limits ?? []) {
		const kind = lim.kind ?? "?";
		let label = CLAUDE_ROW_LABELS[kind];
		if (label === undefined) {
			const model = lim.scope?.model?.display_name ?? kind;
			// On a slim label column the model name is the half that carries
			// information (see Python source for the full rationale).
			label = lim.group === "weekly" && layout.labelW >= LABEL_W ? `weekly ${model}` : model;
		}
		const resetDt = parseResetDate(lim.resets_at);
		lines.push(meterLine(layout, label, lim.percent ?? 0, resetDt, options, claudeLimitPeriodMs(lim)));
	}
	const extra = data.extra_usage;
	if (extra?.is_enabled) {
		const scale = 10 ** (extra.decimal_places ?? 2);
		const used = (extra.used_credits ?? 0) / scale;
		const limit = (extra.monthly_limit ?? 0) / scale;
		lines.push(detailLine(layout, "extra", `$${used.toFixed(2)} / $${limit.toFixed(2)}`, options));
	}
	return lines;
}

// --- Codex block ------------------------------------------------------------

export interface CodexWindow {
	limit_window_seconds?: number;
	used_percent?: number | null;
	reset_at?: number;
}

export interface CodexUsage {
	plan_type?: string;
	rate_limit?: { primary_window?: CodexWindow; secondary_window?: CodexWindow };
	rate_limit_reset_credits?: { available_count?: number };
}

export function windowLabel(seconds: number): string {
	if (seconds >= 6 * 86_400) return "weekly";
	return `${Math.trunc(seconds / 3600)}h`;
}

export function renderCodexUsage(layout: Layout, data: CodexUsage, options: RenderOptions): string[] {
	const lines: string[] = [];
	const rl = data.rate_limit ?? {};
	for (const key of ["primary_window", "secondary_window"] as const) {
		const win = rl[key];
		if (!win) continue;
		const resetDt = parseResetDate(win.reset_at ? win.reset_at * 1000 : null);
		// Codex states its window length outright, so no inference is needed here.
		const periodMs = win.limit_window_seconds ? win.limit_window_seconds * 1000 : null;
		lines.push(
			meterLine(layout, windowLabel(win.limit_window_seconds ?? 0), win.used_percent ?? 0, resetDt, options, periodMs),
		);
	}
	const credits = data.rate_limit_reset_credits?.available_count;
	if (credits) lines.push(detailLine(layout, "credits", String(credits), options));
	return lines;
}
