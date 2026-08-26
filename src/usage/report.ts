/**
 * The usage account walk (REQ-006), shared by the CLI and the in-session view
 * (REQ-010). One place decides WHICH accounts exist, which one is live, and
 * what an unavailable account says; the callers decide where the lines go.
 *
 * Pi-free by construction: refresh arrives as a callback, so this module keeps
 * the same "pure usage domain" layering as cells / layout / render.
 */

import { PROVIDER_IDS, type ProviderId, type SeatStore } from "../store/schema.ts";
import type { RefreshCallback } from "../store/refresh.ts";
import type { SeatStorageBackend } from "../store/storage.ts";
import { resolveSelection, type Selection } from "../store/selector.ts";
import {
	builtinUsage,
	fetchPreparedUsage,
	prepareProfile,
	type BuiltinUsageResult,
	type ProfilePrepareResult,
	type ProfileUsageResult,
	type UsageFetchOptions,
} from "./fetch.ts";
import { planLayout, type Layout } from "./layout.ts";
import {
	accountLine,
	hintLine,
	prefixLine,
	renderClaudeUsage,
	renderCodexUsage,
	sectionLines,
	type ClaudeUsage,
	type CodexUsage,
	type RenderOptions,
	type Segment,
} from "./render.ts";

/** Display name of a provider's built-in (auth.json) credential. */
export function builtinName(provider: ProviderId): string {
	return provider === "anthropic" ? "Claude" : "Codex";
}

export type UsageAccountResult =
	| { ok: true; usage: ClaudeUsage | CodexUsage }
	/** `failed` distinguishes "we could not read it" (CLI exit 1) from an
	 * expected state like Pi's own token having expired. */
	| { ok: false; hint: string; failed: boolean };

export interface UsageAccount {
	provider: ProviderId;
	kind: "profile" | "builtin";
	/** Profile label, or the built-in display name. */
	name: string;
	/** Store label, absent for the built-in snapshot. */
	label?: string;
	aliases: string[];
	/** Trailing state word on the account header. */
	note: string;
	result: UsageAccountResult;
}

export interface UsageCollectDeps {
	backend: SeatStorageBackend;
	/**
	 * Decoded ONCE by the caller and shared with whatever resolved `pins`.
	 * Reading the store again here would let a concurrent rename land between
	 * the two reads, and then the selection and the enumeration describe
	 * different stores: the report says "nothing is active" while quietly
	 * fetching the renamed profile's usage.
	 */
	store: SeatStore;
	authPath: string;
	pins: Partial<Record<ProviderId, string>>;
	/** REQ-005 refresh path for stored profiles, per provider. */
	refreshFor: (provider: ProviderId) => RefreshCallback;
	fetchOptions?: UsageFetchOptions;
}

/** Codex carries its plan on the header row; Claude has nothing to add. */
function planNote(provider: ProviderId, usage: ClaudeUsage | CodexUsage): string {
	return provider === "anthropic" ? "" : String((usage as CodexUsage).plan_type ?? "");
}

// --- sections ---------------------------------------------------------------

export interface UsageSection {
	provider: ProviderId;
	/** This process's effective selection for the provider (pin > default > built-in). */
	selection: Selection;
}

/**
 * The provider sections, in walk order. Pure over the store snapshot, so a
 * view can paint its headers before a single usage request has landed — and so
 * a provider with no accounts at all still says what it is using.
 */
export function usageSections(store: SeatStore, pins: Partial<Record<ProviderId, string>>): UsageSection[] {
	return PROVIDER_IDS.map((provider) => ({ provider, selection: resolveSelection(store, provider, pins[provider]) }));
}

/** One wording for an effective selection, shared by `seat status`, the section
 * header and the view. */
export function selectionSummary(selection: Selection): string {
	return selection.source === "builtin" ? "Pi built-in login" : `${selection.label} (${selection.source})`;
}

export function renderSectionHeader(layout: Layout, section: UsageSection, options: RenderOptions): string[] {
	return sectionLines(layout, `${section.provider.toUpperCase()} · ${selectionSummary(section.selection)}`, options);
}

/**
 * Is this account the provider's effective selection under `sections`?
 *
 * Derived, never stored on the account: the in-session view mutates the
 * default while its meters are already on screen, and a flag frozen at fetch
 * time would leave the dot on the account the user just switched away from
 * until the whole report was fetched again.
 */
export function isLive(sections: readonly UsageSection[], account: UsageAccount): boolean {
	const selection = sections.find((s) => s.provider === account.provider)?.selection;
	if (selection === undefined) return false;
	if (account.kind === "builtin") return selection.source === "builtin";
	return selection.source !== "builtin" && selection.label === account.label;
}

/** One account's fetch, resolved without rejecting. See `collectUsage`. */
type SettledAccount = { value: UsageAccount | undefined } | { error: unknown };

/**
 * Attach the rejection handler at LAUNCH, not at drain. The drain awaits in
 * order, so an account that fails early would otherwise leave every
 * still-in-flight account behind it unawaited — an unhandled rejection.
 * `builtinUsage` really can reject: it calls readForeignFileNoFollow outside
 * its own try block, which throws on a non-regular auth.json.
 */
function settleAccount(promise: Promise<UsageAccount | undefined>): Promise<SettledAccount> {
	return promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
}

/** One account in walk order, before anything has been fetched for it. */
type Slot =
	| { kind: "profile"; provider: ProviderId; label: string; aliases: string[] }
	| { kind: "builtin"; provider: ProviderId };

/** Walk order, derived from the store snapshot alone — no I/O, no lock. */
function planSlots(deps: UsageCollectDeps): Slot[] {
	const slots: Slot[] = [];
	for (const provider of PROVIDER_IDS) {
		const section = deps.store.providers[provider];
		const selection = resolveSelection(deps.store, provider, deps.pins[provider]);
		const activeLabel = selection.source === "builtin" ? undefined : selection.label;

		// The effective selection leads its section: it is the account the user
		// opened the report to read, so it is also the first one emitted.
		const labels = Object.keys(section?.profiles ?? {});
		const ordered =
			activeLabel !== undefined && labels.includes(activeLabel)
				? [activeLabel, ...labels.filter((label) => label !== activeLabel)]
				: labels; // a dangling default/pin names no stored profile — nothing to hoist

		const profiles: Slot[] = ordered.map((label) => ({
			kind: "profile",
			provider,
			label,
			aliases: Object.keys(section?.aliases ?? {})
				.filter((alias) => section?.aliases[alias] === label)
				.sort(),
		}));
		const builtin: Slot = { kind: "builtin", provider };

		if (selection.source === "builtin") slots.push(builtin, ...profiles);
		else slots.push(...profiles, builtin);
	}
	return slots;
}

function profileAccount(slot: Slot & { kind: "profile" }, result: ProfileUsageResult): UsageAccount {
	const common = { provider: slot.provider, kind: "profile", name: slot.label, label: slot.label, aliases: slot.aliases } as const;
	return result.ok
		? { ...common, note: planNote(slot.provider, result.usage), result: { ok: true, usage: result.usage } }
		: { ...common, note: "unavailable", result: { ok: false, hint: result.error, failed: true } };
}

function builtinAccount(provider: ProviderId, builtin: BuiltinUsageResult): UsageAccount | undefined {
	if (builtin === undefined) return undefined;
	const common = { provider, kind: "builtin" as const, name: builtinName(provider), aliases: [] };
	if ("ok" in builtin && builtin.ok) {
		return { ...common, note: planNote(provider, builtin.usage) || "built-in", result: { ok: true, usage: builtin.usage } };
	}
	if ("expired" in builtin) {
		return {
			...common,
			note: "token expired",
			result: { ok: false, hint: "run pi once to refresh it — seat never touches Pi's grant", failed: false },
		};
	}
	const hint = "error" in builtin ? builtin.error : "unavailable";
	return { ...common, note: "unavailable", result: { ok: false, hint, failed: true } };
}

/**
 * Every stored profile plus each provider's built-in snapshot, in render
 * order. `onAccount` fires as each account resolves so a live view can paint
 * incrementally; the returned array is the same sequence.
 *
 * Two phases, because the two halves of an account's usage have opposite
 * concurrency constraints (DEC-011):
 *
 * 1. SERIAL — credential preparation. `prepareProfile` takes the store lock,
 *    and `backend.read` acquires it with a SYNCHRONOUS Atomics.wait spin while
 *    `withLockAsync` holds it across a refresh round trip. Overlapping these
 *    self-deadlocks in a single process: the second profile's sync acquire
 *    freezes the event loop that the first one needs to finish and release,
 *    and both die on the 5s timeout. Costs nothing when credentials are fresh.
 * 2. CONCURRENT — usage endpoints. These touch no store state and take no
 *    lock, and they are the whole latency: awaiting them inside the walk made
 *    total time the SUM of every round trip (~540ms each, ~2.2s over 4
 *    accounts, against ~30ms of local work), growing linearly with profile
 *    count.
 *
 * Ordering comes from the drain, never from settle order, because AC-011a pins
 * rendering against golden fixtures and DEC-009 needs a stable sequence under
 * the view's cursor.
 */
export async function collectUsage(
	deps: UsageCollectDeps,
	onAccount?: (account: UsageAccount) => void,
): Promise<UsageAccount[]> {
	const fetchOptions = deps.fetchOptions ?? {};
	const slots = planSlots(deps);

	// Phase 1, strictly one at a time. See the lock note above.
	const prepared: (ProfilePrepareResult | undefined)[] = [];
	for (const slot of slots) {
		prepared.push(
			slot.kind === "profile"
				? await prepareProfile(deps.backend, slot.provider, slot.label, deps.refreshFor(slot.provider), fetchOptions)
				: undefined,
		);
	}

	// Phase 2, all at once.
	const pending = slots.map((slot, index): Promise<SettledAccount> => {
		if (slot.kind === "builtin") {
			return settleAccount(builtinUsage(deps.authPath, slot.provider, fetchOptions).then((b) => builtinAccount(slot.provider, b)));
		}
		const result = prepared[index];
		if (result === undefined || !result.ok) {
			// Preparation already failed; nothing to fetch, but the account still
			// renders its error in place.
			const error = result === undefined ? "credential unavailable" : result.error;
			return settleAccount(Promise.resolve(profileAccount(slot, { ok: false, label: slot.label, error })));
		}
		return settleAccount(
			fetchPreparedUsage(slot.provider, slot.label, result.prepared, fetchOptions).then((r) => profileAccount(slot, r)),
		);
	});

	const accounts: UsageAccount[] = [];
	for (const entry of pending) {
		const settled = await entry;
		// Re-thrown where a sequential walk would have surfaced it, so callers
		// still see the first failure in render order.
		if ("error" in settled) throw settled.error;
		if (settled.value === undefined) continue;
		accounts.push(settled.value);
		onAccount?.(settled.value);
	}

	return accounts;
}

/** Header row plus the provider's meter block, or the failure hint. */
export function renderAccountBlock(layout: Layout, account: UsageAccount, options: RenderOptions, live: boolean): string[] {
	// The dot claims a working credential, so a failed account never lights up
	// even when the selection points at it.
	const dot = live && account.result.ok;
	const lines = [accountLine(layout, account.name, account.aliases, dot, account.note, options)];
	if (account.result.ok) {
		lines.push(
			...(account.provider === "anthropic"
				? renderClaudeUsage(layout, account.result.usage as ClaudeUsage, options)
				: renderCodexUsage(layout, account.result.usage as CodexUsage, options)),
		);
	} else {
		lines.push(hintLine(layout, account.result.hint, options));
	}
	return lines;
}

/**
 * A left gutter on every account row, for an interactive view's selection
 * marker. Section headers keep the full width — they are not selectable.
 */
export interface ReportGutter {
	/** Columns reserved. Account rows are laid out at `width - cells`, which is
	 * what makes prefixing them safe. */
	cells: number;
	/** Marker for the account at `index` (walk order); pad it to `cells`. */
	marker: (index: number) => Segment;
}

/**
 * Assembles the report's rows in walk order, opening each provider section the
 * first time it is needed.
 *
 * Stateful because the CLI paints accounts as they land and cannot look ahead
 * to know which account opens a section; the view hands it the whole array and
 * gets the same rows, so the two surfaces cannot drift.
 */
export class UsageReportRows {
	private opened = 0;
	private index = 0;
	private readonly headerLayout: Layout;
	private readonly accountLayout: Layout;
	private readonly gutter: ReportGutter | undefined;

	constructor(
		private readonly sections: readonly UsageSection[],
		width: number,
		private readonly options: RenderOptions,
		gutter?: ReportGutter,
	) {
		// Below the gutter's own width there is no content left to mark, and a
		// marker on a zero-width row is just an overflow. Drop it instead.
		this.gutter = gutter !== undefined && width > gutter.cells + 1 ? gutter : undefined;
		this.headerLayout = planLayout(width);
		this.accountLayout = planLayout(width - (this.gutter?.cells ?? 0));
	}

	/** One account's rows, preceded by the headers of any section it opens. */
	account(account: UsageAccount): string[] {
		const rows = this.openThrough(this.sections.findIndex((s) => s.provider === account.provider));
		// A header already separates its own first account; a blank line after the
		// rule would leave the rule floating above nothing.
		if (rows.length === 0) rows.push("");
		const index = this.index;
		this.index += 1;
		const block = renderAccountBlock(this.accountLayout, account, this.options, isLive(this.sections, account));
		const gutter = this.gutter;
		if (gutter === undefined) rows.push(...block);
		else for (const line of block) rows.push(prefixLine(gutter.marker(index), line, this.options.color));
		return rows;
	}

	/** Headers for the sections no account opened — a provider with nothing to
	 * meter still has to say what it is using. Call once, after the walk. */
	rest(): string[] {
		return this.openThrough(this.sections.length - 1);
	}

	private openThrough(index: number): string[] {
		const rows: string[] = [];
		while (this.opened <= index) {
			const section = this.sections[this.opened]!;
			this.opened += 1;
			rows.push("", ...renderSectionHeader(this.headerLayout, section, this.options));
		}
		return rows;
	}
}
