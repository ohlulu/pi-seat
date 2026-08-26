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
import { planLayout } from "../usage/layout.ts";
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
	DIM,
	SPINNER_FRAMES,
	SPINNER_INTERVAL_MS,
	emitLine,
	type RenderOptions,
	type Segment,
} from "../usage/render.ts";

/**
 * How often a loaded view re-measures its "resets in …" countdowns. They are
 * minute-grained, so this only has to be well under a minute; the spinner's
 * 80ms would be burning frames to redraw an unchanged screen.
 */
export const IDLE_TICK_MS = 20_000;

export const VIEW_TITLE = "seat usage";
export const VIEW_LEGEND = "esc/q close · r refresh";
export const LOADING_TEXT = "loading usage…";

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

export class UsageView {
	private accounts: UsageAccount[] = [];
	private sections: UsageSection[] = [];
	private store: SeatStore | undefined;
	private loading = true;
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
		this.loading = true;
		this.error = undefined;
		this.accounts = [];
		this.sections = [];
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
		if (data === "r" && !this.loading) void this.load();
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
		const layout = planLayout(width);
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
		const rows = new UsageReportRows(this.sections, layout, options);
		for (const account of this.accounts) lines.push(...rows.account(account));
		lines.push(...rows.rest());

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
