/**
 * The usage account walk (REQ-006), shared by the CLI and the in-session view
 * (REQ-010). One place decides WHICH accounts exist, which one is live, and
 * what an unavailable account says; the callers decide where the lines go.
 *
 * Pi-free by construction: refresh arrives as a callback, so this module keeps
 * the same "pure usage domain" layering as cells / layout / render.
 */

import { PROVIDER_IDS, type ProviderId } from "../store/schema.ts";
import type { RefreshCallback } from "../store/refresh.ts";
import { decodeStore, type SeatStorageBackend } from "../store/storage.ts";
import { resolveSelection } from "../store/selector.ts";
import { builtinUsage, profileUsage, type UsageFetchOptions } from "./fetch.ts";
import type { Layout } from "./layout.ts";
import {
	accountLine,
	hintLine,
	renderClaudeUsage,
	renderCodexUsage,
	type ClaudeUsage,
	type CodexUsage,
	type RenderOptions,
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
	/** This account is the provider's effective selection for this process.
	 * A fact about the selection, not about health — the liveness dot is a
	 * rendering decision made in renderAccountBlock. */
	live: boolean;
	/** Trailing state word on the account header. */
	note: string;
	result: UsageAccountResult;
}

export interface UsageCollectDeps {
	backend: SeatStorageBackend;
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

/**
 * Every stored profile plus each provider's built-in snapshot, in render
 * order. `onAccount` fires as each account resolves so a live view can paint
 * incrementally; the returned array is the same sequence.
 */
export async function collectUsage(
	deps: UsageCollectDeps,
	onAccount?: (account: UsageAccount) => void,
): Promise<UsageAccount[]> {
	const accounts: UsageAccount[] = [];
	const emit = (account: UsageAccount): void => {
		accounts.push(account);
		onAccount?.(account);
	};

	const store = deps.backend.read((current) => decodeStore(current));
	const fetchOptions = deps.fetchOptions ?? {};

	for (const provider of PROVIDER_IDS) {
		const section = store.providers[provider];
		const selection = resolveSelection(store, provider, deps.pins[provider]);
		const activeLabel = selection.source === "builtin" ? undefined : selection.label;

		for (const label of Object.keys(section?.profiles ?? {})) {
			const aliases = Object.keys(section?.aliases ?? {})
				.filter((alias) => section?.aliases[alias] === label)
				.sort();
			const live = label === activeLabel;
			const result = await profileUsage(deps.backend, provider, label, deps.refreshFor(provider), fetchOptions);
			const common = { provider, kind: "profile", name: label, label, aliases, live } as const;
			if (result.ok) emit({ ...common, note: planNote(provider, result.usage), result: { ok: true, usage: result.usage } });
			else emit({ ...common, note: "unavailable", result: { ok: false, hint: result.error, failed: true } });
		}

		const builtin = await builtinUsage(deps.authPath, provider, fetchOptions);
		if (builtin === undefined) continue;
		const live = selection.source === "builtin";
		const name = builtinName(provider);
		if ("ok" in builtin && builtin.ok) {
			emit({ provider, kind: "builtin", name, aliases: [], live, note: planNote(provider, builtin.usage) || "built-in", result: { ok: true, usage: builtin.usage } });
		} else if ("expired" in builtin) {
			emit({
				provider,
				kind: "builtin",
				name,
				aliases: [],
				live,
				note: "token expired",
				result: { ok: false, hint: "run pi once to refresh it — seat never touches Pi's grant", failed: false },
			});
		} else {
			const hint = "error" in builtin ? builtin.error : "unavailable";
			emit({ provider, kind: "builtin", name, aliases: [], live, note: "unavailable", result: { ok: false, hint, failed: true } });
		}
	}

	return accounts;
}

/** Header row plus the provider's meter block, or the failure hint. */
export function renderAccountBlock(layout: Layout, account: UsageAccount, options: RenderOptions): string[] {
	// The dot claims a working credential, so a failed account never lights up
	// even when the selection points at it.
	const dot = account.live && account.result.ok;
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
