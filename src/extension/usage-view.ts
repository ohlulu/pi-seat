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

import type { ProviderId } from "../store/schema.ts";
import { decodeStore } from "../store/storage.ts";
import { resolveSelection } from "../store/selector.ts";
import { PROVIDER_IDS } from "../store/schema.ts";
import { cellClip, stripAnsi, visibleCellWidth } from "../usage/cells.ts";
import { planLayout } from "../usage/layout.ts";
import { collectUsage, renderAccountBlock, type UsageAccount, type UsageCollectDeps } from "../usage/report.ts";
import {
	BOLD,
	DIM,
	SPINNER_FRAMES,
	SPINNER_INTERVAL_MS,
	emitLine,
	type RenderOptions,
	type Segment,
} from "../usage/render.ts";

export const VIEW_TITLE = "seat usage";
export const VIEW_LEGEND = "esc/q close · r refresh";
export const LOADING_TEXT = "loading usage…";

export interface UsageViewDeps extends UsageCollectDeps {
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
		const tick = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
		this.timer = tick(() => {
			if (this.disposed || !this.loading) return;
			this.frame += 1;
			this.changed();
		}, SPINNER_INTERVAL_MS);
		void this.load();
	}

	/** Re-fetch. Credential refresh happens inside collectUsage, on the REQ-005
	 * locked single-flight path — the view never touches a token itself. */
	private async load(): Promise<void> {
		const generation = (this.generation += 1);
		this.loading = true;
		this.error = undefined;
		this.accounts = [];
		this.changed();
		try {
			const accounts = await collectUsage(this.deps, (account) => {
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
		for (const line of this.headerLines()) lines.push(row([["  ", undefined], [line, DIM]]));

		if (this.loading) {
			const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? "";
			lines.push("", row([[`${spinner} ${LOADING_TEXT}`, DIM]]));
		}
		if (this.error !== undefined) {
			lines.push("", row([[`seat: ${this.error}`, DIM]]));
		}
		for (const account of this.accounts) {
			lines.push("", ...renderAccountBlock(layout, account, options));
		}
		lines.push("", row([[VIEW_LEGEND, DIM]]));
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.disposed = true;
		const clear = this.deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
		if (this.timer !== undefined) clear(this.timer);
		this.timer = undefined;
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

	/** The default/pin state REQ-010 asks the view to show alongside the bars. */
	private headerLines(): string[] {
		let store;
		try {
			store = this.deps.backend.read((current) => decodeStore(current));
		} catch (error) {
			return [`store unreadable — ${error instanceof Error ? error.message : String(error)}`];
		}
		return PROVIDER_IDS.map((provider: ProviderId) => {
			const selection = resolveSelection(store, provider, this.deps.pins[provider]);
			const detail = selection.source === "builtin" ? "Pi built-in login" : `${selection.label} (${selection.source})`;
			return `${provider}: ${detail}`;
		});
	}
}

/** esc or q closes (AC-018). Exact match, so `esc [ A` (an arrow key) is not a
 * close: an escape sequence arrives as one longer string. */
export function isCloseKey(data: string): boolean {
	return data === "\x1b" || data === "q" || data === "Q";
}
