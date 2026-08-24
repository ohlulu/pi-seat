/**
 * Column layout tiers (REQ-006) — direct port of Python seat's plan_layout.
 *
 * Tiers run richest-first; the invariant the tests pin is that no column ever
 * gets worse as the terminal grows. Budget is width-1, not width: a line
 * landing exactly on the last column leaves many terminals in deferred-wrap
 * state.
 */

export const INDENT = 2;
export const GAP = 2;
export const PCT_W = 4; // "100%"
export const LABEL_W = 13; // "weekly Sonnet", "credits"
export const LABEL_W_SLIM = 8;
export const RESET_W_LONG = 20; // "in 6d23h · Tue 11:59"
export const RESET_W_SHORT = 9; // "in 23h13m", "resetting"
export const BAR_MAX = 20;
export const BAR_COMFORT = 14;
export const BAR_MIN = 8;

export interface Layout {
	width: number;
	labelW: number;
	barW: number;
	resetW: number;
}

const TIERS: readonly (readonly [labelW: number, resetW: number, floor: number])[] = [
	[LABEL_W, RESET_W_LONG, BAR_COMFORT],
	[LABEL_W, RESET_W_SHORT, BAR_COMFORT],
	[LABEL_W, RESET_W_SHORT, BAR_MIN],
	[LABEL_W_SLIM, RESET_W_SHORT, BAR_MIN],
	[LABEL_W_SLIM, 0, BAR_MIN],
];

export function planLayout(width: number): Layout {
	for (const [labelW, resetW, floor] of TIERS) {
		let fixed = INDENT + labelW + GAP + GAP + PCT_W;
		if (resetW) fixed += GAP + resetW;
		const barW = width - 1 - fixed;
		if (barW >= floor) {
			return { width, labelW, barW: Math.min(barW, BAR_MAX), resetW };
		}
	}
	return { width, labelW: LABEL_W_SLIM, barW: BAR_MIN, resetW: 0 };
}
