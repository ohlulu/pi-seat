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
 * - Nothing here opens nested UI while the view is up. The reset confirmation
 *   (REQ-012) is a state of this component, drawn in its own rows — not a
 *   second `ctx.ui.custom()`, whose promise never resolves without
 *   `{ overlay: true }`.
 *
 * The component is Pi-free: it takes callbacks for redraw and close, so a test
 * can drive `render`/`handleInput` with no terminal.
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { SeatCredential, SeatStore } from "../store/schema.ts";
import type { StoreSchedule } from "../store/scheduler.ts";
import { decodeStore } from "../store/storage.ts";
import { redactTokenText } from "../store/redact.ts";
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
	YELLOW,
	SPINNER_FRAMES,
	SPINNER_INTERVAL_MS,
	emitLine,
	type RenderOptions,
	type Segment,
} from "../usage/render.ts";
import { findResetOffer, redeemReset, resetCredential, type ResetOffer, type ResetRequestOptions } from "../usage/resets.ts";
import { DEFAULT_KEYWORD, describeUseResult, runMutation, useSelection } from "./commands.ts";

/**
 * How often a loaded view re-measures its "resets in …" countdowns. They are
 * minute-grained, so this only has to be well under a minute; the spinner's
 * 80ms would be burning frames to redraw an unchanged screen.
 */
export const IDLE_TICK_MS = 20_000;

export const VIEW_TITLE = "seat usage";
export const VIEW_LEGEND = "↑↓ select · enter switch · x reset · r refresh · esc/q close";
export const LOADING_TEXT = "loading usage…";
export const RESET_CHECKING_TEXT = "checking resets…";
export const RESET_REDEEMING_TEXT = "using reset…";
export const RESET_CONFIRM_LEGEND = "y use reset · n/esc keep it";

/**
 * The reset flow for one account (REQ-012). `confirm` holds the credential the
 * offer was found with, so the redeem rides the same grant the user saw.
 */
type ResetFlow =
	| { phase: "checking"; account: UsageAccount }
	| { phase: "confirm"; account: UsageAccount; offer: ResetOffer; credential: SeatCredential; secrets: string[] }
	| { phase: "redeeming"; account: UsageAccount; offer: ResetOffer };

/**
 * Columns reserved on the left of every account row for the selection marker.
 * Taken from EVERY account, not just the selected one — a gutter that only the
 * selected block pays for makes the meters jump sideways under the cursor.
 */
export const GUTTER_CELLS = 2;
export const MARK_SELECTED = "▌ ";
export const MARK_PLAIN = "  ";

export interface UsageViewDeps extends Omit<UsageCollectDeps, "store"> {
	/** The extension's store schedule: the view runs while requests resolve auth (DEC-013). */
	schedule: StoreSchedule;
	color?: boolean;
	now?: () => Date;
	timeZone?: string;
	/** Idempotency key for a redeem; random per attempt in production. */
	resetRequestId?: () => string;
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

/**
 * Where the cursor lands after a reload: on the same account when it is still
 * there, otherwise clamped into the new list so it always points at something.
 */
function restoreCursor(accounts: readonly UsageAccount[], previous: UsageAccount | undefined, current: number): number {
	if (accounts.length === 0) return 0;
	if (previous !== undefined) {
		const key = accountKey(previous);
		const found = accounts.findIndex((account) => accountKey(account) === key);
		if (found >= 0) return found;
	}
	return Math.min(Math.max(0, current), accounts.length - 1);
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
	private reset: ResetFlow | undefined;
	/** Bumped when a flow starts or is cancelled, so a late lookup cannot reopen it. */
	private resetGeneration = 0;
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
	private async load(status?: string): Promise<void> {
		const generation = (this.generation += 1);
		const previous = this.accounts[this.selected];
		this.loading = true;
		this.error = undefined;
		this.accounts = [];
		this.sections = [];
		this.status = status;
		this.retime();
		try {
			// Read once, so the section headers and the bars describe the same store.
			this.store = await this.deps.schedule(() => this.deps.backend.read((current) => decodeStore(current)));
			if (this.disposed || generation !== this.generation) return;
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
		// Placed after the catch, not on the success path: a walk that throws
		// part-way (a foreign auth.json that is not a regular file is one real
		// case) leaves the streamed accounts in place, and a cursor left pointing
		// past them shows no marker and makes enter a silent no-op.
		this.selected = restoreCursor(this.accounts, previous, this.selected);
		this.loading = false;
		this.retime();
		this.changed();
	}

	handleInput(data: string): void {
		// An open reset flow owns the keyboard, close keys included: esc on a
		// confirmation means "keep my reset", not "close the whole view".
		if (this.reset !== undefined) {
			this.handleResetInput(data);
			return;
		}
		if (isCloseKey(data)) {
			this.hooks.onClose();
			return;
		}
		if (this.loading) return; // nothing stable to move over or switch to yet
		if (data === "r") void this.load();
		else if (isResetKey(data)) void this.startReset();
		else if (isUpKey(data)) this.move(-1);
		else if (isDownKey(data)) this.move(1);
		else if (isEnterKey(data)) void this.applySelection();
	}

	private handleResetInput(data: string): void {
		const flow = this.reset;
		if (flow === undefined || flow.phase === "redeeming") return; // a sent redeem cannot be called back
		if (flow.phase === "confirm" && matchesKey(data, "y")) {
			void this.redeem(flow);
			return;
		}
		if (isCloseKey(data) || matchesKey(data, "n")) {
			this.resetGeneration += 1;
			this.reset = undefined;
			this.changed();
		}
	}

	/**
	 * `x`: look up the reset the highlighted account would use, then ask.
	 *
	 * The lookup is fresh rather than read off the meters: the count on screen
	 * may be minutes old, and the confirmation has to name the exact credit or
	 * grant the redeem will send.
	 */
	private async startReset(): Promise<void> {
		const account = this.accounts[this.selected];
		if (account === undefined) return;
		const generation = (this.resetGeneration += 1);
		this.reset = { phase: "checking", account };
		this.status = undefined;
		this.changed();
		let secrets: string[] = [];
		let next: ResetFlow | undefined;
		let status: string | undefined;
		try {
			const access = await resetCredential(this.deps, account);
			if (!access.ok) {
				status = `${account.name}: ${access.message}`;
			} else {
				secrets = access.secrets;
				const lookup = await findResetOffer(account.provider, access.credential, this.deps.fetchOptions ?? {});
				if (lookup.kind === "none") status = `${account.name}: ${lookup.message}`;
				else next = { phase: "confirm", account, offer: lookup.offer, credential: access.credential, secrets };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			status = `${account.name}: could not check resets: ${redactTokenText(message, secrets)}`;
		}
		if (this.disposed || generation !== this.resetGeneration) return;
		this.reset = next;
		this.status = status;
		this.changed();
	}

	/** `y` on the confirmation. A used reset changes the limits, so the meters are refetched. */
	private async redeem(flow: Extract<ResetFlow, { phase: "confirm" }>): Promise<void> {
		this.reset = { phase: "redeeming", account: flow.account, offer: flow.offer };
		this.changed();
		const options: ResetRequestOptions = {
			...this.deps.fetchOptions,
			...(this.deps.resetRequestId !== undefined ? { requestId: this.deps.resetRequestId } : {}),
		};
		const outcome = await redeemReset(flow.credential, flow.offer, flow.secrets, options);
		if (this.disposed) return;
		this.reset = undefined;
		const status = `${flow.account.name}: ${outcome.message}`;
		if (outcome.used) {
			void this.load(status);
			return;
		}
		this.status = status;
		this.changed();
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
	private async applySelection(): Promise<void> {
		const account = this.accounts[this.selected];
		if (account === undefined) return;
		const name = account.kind === "builtin" ? DEFAULT_KEYWORD : account.label;
		if (name === undefined) return;
		try {
			const { result, store } = await this.deps.schedule(() => ({
				result: runMutation(this.deps.backend, (current) => useSelection(current, `${account.provider}:${name}`)),
				store: this.deps.backend.read((current) => decodeStore(current)),
			}));
			if (this.disposed) return;
			this.store = store;
			this.sections = usageSections(this.store, this.deps.pins);
			this.status = describeUseResult(result, this.deps.pins);
		} catch (error) {
			if (this.disposed) return;
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
		if (this.reset !== undefined) {
			// Last, where the legend would be: the view can outgrow the screen, and
			// the bottom rows are the ones that stay visible.
			lines.push("", ...this.resetRows(this.reset, row, options));
			return lines;
		}
		lines.push("", row([[VIEW_LEGEND, DIM]]));
		return lines;
	}

	private resetRows(flow: ResetFlow, row: (segments: readonly Segment[]) => string, options: RenderOptions): string[] {
		const title = row([[`reset · ${flow.account.name} (${flow.account.provider})`, BOLD]]);
		if (flow.phase === "checking") return [title, row([[`  ${RESET_CHECKING_TEXT}`, DIM]])];
		const { offer } = flow;
		const expiry = offer.expiresAt !== null ? ` · use by ${formatExpiry(offer.expiresAt, options)}` : "";
		const lines = [title, row([[`  ${offer.title}${expiry}`, undefined]])];
		const refills = offer.refills.length > 0 ? `refills ${offer.refills.join(", ")} · ` : "";
		lines.push(row([[`  ${refills}${offer.remaining} left`, DIM]]));
		if (offer.caveat !== undefined) lines.push(row([[`  ${offer.caveat}`, YELLOW]]));
		lines.push(
			flow.phase === "redeeming"
				? row([[`  ${RESET_REDEEMING_TEXT}`, DIM]])
				: row([[`  Use this reset? It cannot be undone. `, BOLD], [RESET_CONFIRM_LEGEND, DIM]]),
		);
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

/*
 * Key recognition goes through pi-tui's matchesKey, never through literal
 * comparison against escape sequences.
 *
 * Pi negotiates the Kitty keyboard protocol at startup with flags 1|2|4
 * (see pi-tui's Terminal.queryAndEnableKittyProtocol). On a terminal that
 * accepts it — Kitty, Ghostty, WezTerm — esc arrives as `esc [ 27 u` and enter
 * as `esc [ 13 u`, not as `\x1b` and `\r`. tmux does not negotiate it, so the
 * TUI smoke passes either way and cannot catch this class of bug on its own.
 * matchesKey covers legacy, application-cursor, modifyOtherKeys and CSI-u in
 * one place; it also knows that under Kitty a bare `\n` is shift+enter, not
 * enter.
 */

/** esc or q closes (AC-018). */
export function isCloseKey(data: string): boolean {
	return matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, "shift+q");
}

export function isUpKey(data: string): boolean {
	return matchesKey(data, Key.up) || matchesKey(data, "k");
}

export function isDownKey(data: string): boolean {
	return matchesKey(data, Key.down) || matchesKey(data, "j");
}

export function isEnterKey(data: string): boolean {
	return matchesKey(data, Key.enter);
}

/** `x` opens the reset flow; `r` is taken by refresh. */
export function isResetKey(data: string): boolean {
	return matchesKey(data, "x");
}

/**
 * "Nov 30 17:36" in the view's zone — a reset's deadline, not a countdown.
 * Assembled from parts because ICU's own pattern varies ("Nov 30 at 17:36").
 */
function formatExpiry(date: Date, options: RenderOptions): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		...(options.timeZone !== undefined ? { timeZone: options.timeZone } : {}),
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${get("month")} ${get("day")} ${get("hour")}:${get("minute")}`;
}
