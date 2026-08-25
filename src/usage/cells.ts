/**
 * Terminal cell arithmetic (REQ-006, DEC-004) — a direct port of the Python
 * seat's cell_width / cell_clip / fit, byte-for-byte output compatible.
 *
 * East Asian W/F glyphs occupy 2 cells; everything else — Ambiguous included —
 * counts 1, because every glyph this view draws (bars, dots, middle dot,
 * ellipsis) is Ambiguous and counting those wide would mis-measure every row.
 * No third-party width library: their Ambiguous handling is not under our
 * control (DEC-004), and parity with the Python renderer is the contract.
 */

import { EAW_WIDE_RANGES } from "./eaw-wide.ts";

const ELLIPSIS = "\u2026";

function isWide(codePoint: number): boolean {
	let lo = 0;
	let hi = EAW_WIDE_RANGES.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const range = EAW_WIDE_RANGES[mid]!;
		if (codePoint < range[0]) hi = mid - 1;
		else if (codePoint > range[1]) lo = mid + 1;
		else return true;
	}
	return false;
}

/** Terminal cells occupied by `text` (code-point iteration, like Python). */
export function cellWidth(text: string): number {
	let total = 0;
	for (const char of text) total += isWide(char.codePointAt(0)!) ? 2 : 1;
	return total;
}

/** Longest prefix of `text` fitting `width` cells, `…` marking the cut. */
export function cellClip(text: string, width: number): string {
	if (cellWidth(text) <= width) return text;
	if (width <= 0) return "";
	const kept: string[] = [];
	let used = 0;
	for (const char of text) {
		const size = isWide(char.codePointAt(0)!) ? 2 : 1;
		if (used + size > width - 1) break;
		kept.push(char);
		used += size;
	}
	// Stopping in front of a wide glyph can leave one cell over; spend it on
	// padding so the … still lands exactly on the last column.
	return kept.join("") + " ".repeat(width - 1 - used) + ELLIPSIS;
}

// SGR / OSC-8 sequences carry no display width. Kept narrow on purpose: this
// only has to cover what render.ts emits (colour codes and resets).
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

/** Cells occupied by an already-coloured line — what a terminal actually shows. */
export function visibleCellWidth(text: string): number {
	return cellWidth(stripAnsi(text));
}

/** Pad or ellipsize to exactly `width` cells so columns stay aligned. */
export function fit(text: string, width: number): string {
	const size = cellWidth(text);
	if (size > width) return cellClip(text, width);
	return text + " ".repeat(width - size);
}
