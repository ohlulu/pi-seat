/**
 * In-session usage view (REQ-010, DEC-007).
 *
 * A `ctx.ui.custom()` component that shows the same meters as `seat usage`
 * plus the session's default/pin state. Rendering is not reimplemented here:
 * every row is produced by src/usage (report → render → cells), so the view and
 * the CLI cannot drift.
 *
 * Rules this file is bound by (pi.md extension gotchas, tui.md):
 *
 * - `render(width)` MUST NOT return a row wider than `width`. Every row goes
 *   through `emitLine`, which clips; `render` then MEASURES what it is about to
 *   return and falls back to a plain clip if anything is still over. Overflow
 *   does not throw here — Pi's renderer throws a tick later, from its own loop,
 *   where nothing can catch it.
 * - The chrome strings (title, legend) are constants, and a constant is still
 *   unbounded text: `width` is the user's terminal. They are clipped like
 *   everything else, which is allowed because their row budget is fixed at one
 *   row each. The render probe sweeps widths 2–200 to prove it.
 * - The spinner is a periodic re-render, so the interval is owned by `dispose`.
 * - Nothing here opens nested UI while the view is up.
 *
 * The component is Pi-free: it takes callbacks for redraw and close, so a test
 * can drive `render`/`handleInput` with no terminal.
 */

import type { SeatStore } from "../store/schema.ts";
import { decodeStore } from "../store/storage.ts";
import { cellClip, stripAnsi, visibleCellWidth } from "../usage/cells.ts";
import {
	UsageReportRows,
	collectUsage,
	usageSections,
	type UsageAccount,
	type UsageCollectDeps,
	type UsageSection,
} from "../usage/report.ts";
import {
	BOLD,
	CYAN,
	DIM,
	SPINNER_FRAMES,
	SPINNER_INTERVAL_MS,
	emitLine,
	type RenderOptions,
	type Segment,
} from "../usage/render.ts";
import { DEFAULT_KEYWORD, describeUseResult, runMutation, useSelection } from "./commands.ts";

/**
 * How often a loaded view re-measures its "resets in …" countdowns. They are
 * minute-grained, so this only has to be well under a minute; the spinner's
 * 80ms would be burning frames to redraw an unchanged screen.
 */
export const IDLE_TICK_MS = 20_000;

export const VIEW_TITLE = "seat usage";
export const VIEW_LEGEND = "↑↓ select · enter switch · r refresh · esc/q close";
export const LOADING_TEXT = "loading usage…";

/**
 * Columns reserved on the left of every account row for the selection marker.
 * Taken from EVERY account, not just the selected one — a gutter that only the
 * selected block pays for makes the meters jump sideways under the cursor.
 */
export const GUTTER_CELLS = 2;
export const MARK_SELECTED = "▌ ";
export const MARK_PLAIN = "  ";

export interface UsageViewDeps extends Omit<UsageCollectDeps, "store"> {
	color?: boolean;
	now?: () => Date;
	timeZone?: string;
	/** Injectable so tests can drive the spinner without real time. */
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}

export interface UsageViewHooks {
	/** Ask the host to re-render (tui.requestRender). */
	onChange(): void;
	/** Close the view (done()). */
	onClose(): void;
}

/** Stable identity of an account across a reload, so `r` does not throw the
 * cursor back to the top. */
function accountKey(account: UsageAccount): string {
	return `${account.provider}\u0000${account.kind}\u0000${account.label ?? ""}`;
}

export class UsageView {
	private accounts: UsageAccount[] = [];
	private sections: UsageSection[] = [];
	private store: SeatStore | undefined;
	private loading = true;
	private selected = 0;
	/** Feedback for the last switch, including AC-016's pin notice. Sticky: it
	 * survives navigation so it can still be read after the cursor moves. */
	private status: string | undefined;
	private error: string | undefined;
	private frame = 0;
	private timer: unknown;
	private disposed = false;
	private generation = 0;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		private readonly deps: UsageViewDeps,
		private readonly hooks: UsageViewHooks,
	) {}

	/** Begin the first fetch and start the spinner. */
	start(): void {
		void this.load();
	}

	/**
	 * One timer at a time: the spinner while fetching, a slow countdown tick
	 * once the meters are up. Leaving the 80ms interval running after the fetch
	 * wakes the process 12 times a second to decide it has nothing to do.
	 */
	private retime(): void {
		const set = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
		this.clearTimer();
		if (this.disposed) return;
		this.timer = this.loading
			? set(() => {
					if (this.disposed || !this.loading) return;
					this.frame += 1;
					this.changed();
				}, SPINNER_INTERVAL_MS)
			: set(() => {
					// Nothing fetched: only the clock moved, and the countdowns are
					// computed at render time from it.
					if (this.disposed || this.loading) return;
					this.changed();
				}, IDLE_TICK_MS);
	}

	private clearTimer(): void {
		const clear = this.deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
		if (this.timer !== undefined) clear(this.timer);
		this.timer = undefined;
	}

	/** Re-fetch. Credential refresh happens inside collectUsage, on the REQ-005
	 * locked single-flight path — the view never touches a token itself. */
	private async load(): Promise<void> {
		const generation = (this.generation += 1);
		const previous = this.accounts[this.selected];
		this.loading = true;
		this.error = undefined;
		this.accounts = [];
		this.sections = [];
		this.status = undefined;
		this.retime();
		try {
			// Read once, so the section headers and the bars describe the same store.
			this.store = this.deps.backend.read((current) => decodeStore(current));
			// Sections are pure over that snapshot, so the headers are on screen from
			// the first frame instead of arriving with the slowest account.
			this.sections = usageSections(this.store, this.deps.pins);
			const accounts = await collectUsage({ ...this.deps, store: this.store }, (account) => {
				// A reload started (or the view closed) while this fetch was in
				// flight: its accounts belong to a screen nobody is looking at.
				if (this.disposed || generation !== this.generation) return;
				this.accounts = [...this.accounts, account];
				this.changed();
			});
			if (this.disposed || generation !== this.generation) return;
			this.accounts = accounts;
			const key = previous === undefined ? undefined : accountKey(previous);
			const restored = key === undefined ? -1 : accounts.findIndex((a) => accountKey(a) === key);
			this.selected = restored >= 0 ? restored : 0;
		} catch (error) {
			if (this.disposed || generation !== this.generation) return;
			this.error = error instanceof Error ? error.message : String(error);
		}
		this.loading = false;
		this.retime();
		this.changed();
	}

	handleInput(data: string): void {
		if (isCloseKey(data)) {
			this.hooks.onClose();
			return;
		}
		if (this.loading) return; // nothing stable to move over or switch to yet
		if (data === "r") void this.load();
		else if (isUpKey(data)) this.move(-1);
		else if (isDownKey(data)) this.move(1);
		else if (isEnterKey(data)) this.applySelection();
	}

	/** Clamped, not wrapping — matching Pi's own SelectList. */
	private move(delta: number): void {
		if (this.accounts.length === 0) return;
		const next = Math.min(this.accounts.length - 1, Math.max(0, this.selected + delta));
		if (next === this.selected) return;
		this.selected = next;
		this.changed();
	}

	/**
	 * Enter: make the highlighted account this provider's default. The built-in
	 * row maps to `use <provider>:default`, which clears the default and hands
	 * the provider back to Pi's own login.
	 *
	 * Usage is deliberately NOT refetched. Liveness is derived from the store
	 * (`isLive`), so re-reading the store is enough to move the dot; refetching
	 * would spend a full round of network requests to redraw one glyph.
	 */
	private applySelection(): void {
		const account = this.accounts[this.selected];
		if (account === undefined) return;
		const name = account.kind === "builtin" ? DEFAULT_KEYWORD : account.label;
		if (name === undefined) return;
		try {
			const result = runMutation(this.deps.backend, (store) => useSelection(store, `${account.provider}:${name}`));
			this.store = this.deps.backend.read((current) => decodeStore(current));
			this.sections = usageSections(this.store, this.deps.pins);
			this.status = describeUseResult(result, this.deps.pins);
		} catch (error) {
			this.status = `seat: ${error instanceof Error ? error.message : String(error)}`;
		}
		// The walk order is left alone on purpose: re-sorting would slide the block
		// out from under the cursor the instant it was chosen. It settles on the
		// next refresh or reopen.
		this.changed();
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		const budget = Math.max(0, width);
		// Backstop, not the guard: rows are already clipped on the way out, so a
		// row measuring over budget here means a bug upstream. Reported as a
		// plain clip rather than a crashed session.
		const lines = this.buildRows(width).map((line) =>
			visibleCellWidth(line) > budget ? cellClip(stripAnsi(line), budget) : line,
		);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	/**
	 * Raw row construction. Exposed for the render probe: probing only the
	 * guarded output would let the backstop hide the overflow the probe exists
	 * to find.
	 */
	buildRows(width: number): string[] {
		const options = this.renderOptions();
		const row = (segments: readonly Segment[]): string => emitLine(segments, Math.max(0, width - 1), options.color);

		const lines: string[] = [row([[VIEW_TITLE, BOLD]])];
		if (this.loading) {
			const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? "";
			lines.push("", row([[`${spinner} ${LOADING_TEXT}`, DIM]]));
		}
		if (this.error !== undefined) {
			lines.push("", row([[`seat: ${this.error}`, DIM]]));
		}
		// REQ-010's default/pin state lives in each provider's section header now,
		// directly above the accounts that selection governs.
		const rows = new UsageReportRows(this.sections, width, options, {
			cells: GUTTER_CELLS,
			marker: (index) => (index === this.selected ? [MARK_SELECTED, CYAN] : [MARK_PLAIN, undefined]),
		});
		for (const account of this.accounts) lines.push(...rows.account(account));
		lines.push(...rows.rest());

		// Undimmed on purpose: in a pinned session this line is the only signal
		// that Enter did anything, because the live dot cannot move.
		if (this.status !== undefined) lines.push("", row([[this.status, undefined]]));
		lines.push("", row([[VIEW_LEGEND, DIM]]));
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.clearTimer();
	}

	private changed(): void {
		if (this.disposed) return;
		this.invalidate();
		this.hooks.onChange();
	}

	private renderOptions(): RenderOptions {
		return {
			color: this.deps.color ?? true,
			now: this.deps.now ?? (() => new Date()),
			...(this.deps.timeZone !== undefined ? { timeZone: this.deps.timeZone } : {}),
		};
	}
}

/** esc or q closes (AC-018). Exact match, so `esc [ A` (an arrow key) is not a
 * close: an escape sequence arrives as one longer string. */
export function isCloseKey(data: string): boolean {
	return data === "\x1b" || data === "q" || data === "Q";
}

// Both cursor encodings: a terminal in application cursor mode sends `esc O A`
// where normal mode sends `esc [ A`, and which one arrives is not ours to
// choose. Recognizing only one makes the arrows work on some terminals only.
export function isUpKey(data: string): boolean {
	return data === "\x1b[A" || data === "\x1bOA" || data === "k";
}

export function isDownKey(data: string): boolean {
	return data === "\x1b[B" || data === "\x1bOB" || data === "j";
}

export function isEnterKey(data: string): boolean {
	return data === "\r" || data === "\n";
}
