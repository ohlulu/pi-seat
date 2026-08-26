/**
 * Shared mutation handlers (REQ-003, REQ-007) — the single command core
 * consumed by both the /seat extension adapter (T032) and the CLI (T027).
 *
 * Handlers are pure functions over a decoded SeatStore: they mutate the given
 * store in place and report `changed`; runMutation wraps them in the locked
 * read-mutate-commit cycle. Alias resolution follows Python seat: switching
 * resolves aliases, `rm <alias>` removes only the alias, renaming a profile
 * retargets its aliases and the default. Destructive operations (profile
 * removal, login overwrite) require an explicit confirmation flag; the caller
 * owns the prompt.
 */

import { isValidLabel, type ProviderId, type ProviderSection, type SeatCredential, type SeatStore } from "../store/schema.ts";
import { decodeStore, encodeStore, type SeatStorageBackend } from "../store/storage.ts";
import { parseSelector, resolveName } from "../store/selector.ts";

/** User-facing operation failure (CLI exit 1). */
export class CommandError extends Error {
	override name = "CommandError";
}

/** Reserved selector name: `use default` clears the provider default. */
export const DEFAULT_KEYWORD = "default";

export interface MutationOutcome {
	changed: boolean;
}

export function runMutation<T extends MutationOutcome>(backend: SeatStorageBackend, fn: (store: SeatStore) => T): T {
	return backend.withLock((current) => {
		const store = decodeStore(current);
		const result = fn(store);
		return result.changed ? { result, next: encodeStore(store) } : { result };
	});
}

function section(store: SeatStore, provider: ProviderId): ProviderSection | undefined {
	return store.providers[provider];
}

function ensureSection(store: SeatStore, provider: ProviderId): ProviderSection {
	let existing = store.providers[provider];
	if (!existing) {
		existing = {
			profiles: Object.create(null) as Record<string, SeatCredential>,
			aliases: Object.create(null) as Record<string, string>,
		};
		store.providers[provider] = existing;
	}
	return existing;
}

function own<T>(map: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(map, key) ? map[key] : undefined;
}

// --- alias validation (shared by login and use) -----------------------------

/** Charset and reserved-name rules. Callable before any store lookup. */
function validateAliasNames(aliases: readonly string[]): void {
	for (const alias of aliases) {
		if (alias === DEFAULT_KEYWORD) throw new CommandError(`"${DEFAULT_KEYWORD}" is a reserved name`);
		if (!isValidLabel(alias)) throw new CommandError(`invalid alias "${alias}" (":" and "," are not allowed)`);
	}
}

/**
 * Structural rules for pointing `aliases` at `label`: an alias may not shadow a
 * profile label (including `label` itself — the schema rejects a store where an
 * alias and a profile share a name) nor steal an alias owned by another
 * profile. Throws before any mutation so a rejected attachment leaves the store
 * untouched.
 */
function assertAliasesAssignable(sec: ProviderSection, label: string, aliases: readonly string[]): void {
	for (const alias of aliases) {
		if (alias === label || own(sec.profiles, alias) !== undefined) {
			throw new CommandError(`alias "${alias}" collides with an existing profile label`);
		}
		const target = own(sec.aliases, alias);
		if (target !== undefined && target !== label) {
			throw new CommandError(`alias "${alias}" already points at "${target}"; rm it first`);
		}
	}
}

// --- use / default ----------------------------------------------------------

export type UseResult = MutationOutcome &
	(
		| { action: "set"; provider: ProviderId; label: string; attachedAliases: string[] }
		| { action: "clear"; provider: ProviderId }
	);

/**
 * `use <selector> [-a <alias>]…`: persist the global default; `use default`
 * clears it. Aliases attach to the resolved profile in the same mutation as the
 * default write (AC-017), so `/seat ohlulu -a o` can never leave a default
 * without its alias or the other way round.
 */
export function useSelection(store: SeatStore, selectorInput: string, aliases: readonly string[] = []): UseResult {
	const selector = parseSelector(selectorInput);
	validateAliasNames(aliases);
	const sec = section(store, selector.provider);

	if (selector.name === DEFAULT_KEYWORD) {
		if (aliases.length > 0) throw new CommandError(`"${DEFAULT_KEYWORD}" clears the default; it has no profile to alias`);
		if (!sec || sec.default === undefined) return { changed: false, action: "clear", provider: selector.provider };
		delete sec.default;
		return { changed: true, action: "clear", provider: selector.provider };
	}

	const label = resolveName(sec, selector.name);
	if (label === undefined || !sec) {
		throw new CommandError(`no profile or alias "${selector.name}" for provider "${selector.provider}"`);
	}
	assertAliasesAssignable(sec, label, aliases);

	const attachedAliases: string[] = [];
	for (const alias of aliases) {
		if (own(sec.aliases, alias) === label) continue; // already attached
		sec.aliases[alias] = label;
		attachedAliases.push(alias);
	}
	const defaultChanged = sec.default !== label;
	sec.default = label;
	return {
		changed: defaultChanged || attachedAliases.length > 0,
		action: "set",
		provider: selector.provider,
		label,
		attachedAliases,
	};
}

/**
 * The one sentence `use` reports, wherever it was invoked from — the extension
 * command, the CLI, or the in-session view. AC-016's "default updated, session
 * keeps its pin" clause is the reason this is shared rather than inlined three
 * times: it is the only feedback a pinned session gets that the command did
 * anything at all, since the selection it is running under does not move.
 */
export function describeUseResult(result: UseResult, pins: Partial<Record<ProviderId, string>>): string {
	const pinned = pins[result.provider];
	const suffix = pinned !== undefined ? ` — this session keeps its pin (${pinned})` : "";
	if (result.action === "clear") return `${result.provider} default cleared; Pi built-in login applies${suffix}`;
	const attached =
		result.attachedAliases.length > 0 ? ` (alias ${result.attachedAliases.join(", ")} → ${result.label})` : "";
	return `${result.provider} default is now "${result.label}"${attached}${suffix}`;
}

// --- login ------------------------------------------------------------------

export type LoginResult = MutationOutcome &
	(
		| { action: "needs-confirm"; provider: ProviderId; label: string }
		| { action: "stored"; provider: ProviderId; label: string; overwrote: boolean }
	);

/**
 * Store a freshly minted credential under a label (REQ-007). Overwriting an
 * existing profile is destructive and requires `confirmedOverwrite` (AC-013).
 */
export function loginProfile(
	store: SeatStore,
	selectorInput: string,
	credential: SeatCredential,
	aliases: readonly string[] = [],
	options: { confirmedOverwrite?: boolean } = {},
): LoginResult {
	const selector = parseSelector(selectorInput);
	const label = selector.name;
	if (label === DEFAULT_KEYWORD) throw new CommandError(`"${DEFAULT_KEYWORD}" is a reserved name`);
	if (!isValidLabel(label)) throw new CommandError(`invalid label "${label}" (":" and "," are not allowed)`);
	validateAliasNames(aliases);

	const sec = ensureSection(store, selector.provider);
	if (own(sec.aliases, label) !== undefined) {
		throw new CommandError(`"${label}" is an alias (of "${own(sec.aliases, label)}"); pick another label or rm the alias first`);
	}
	const exists = own(sec.profiles, label) !== undefined;
	if (exists && !options.confirmedOverwrite) {
		return { changed: false, action: "needs-confirm", provider: selector.provider, label };
	}

	assertAliasesAssignable(sec, label, aliases);

	sec.profiles[label] = credential;
	for (const alias of aliases) sec.aliases[alias] = label;
	return { changed: true, action: "stored", provider: selector.provider, label, overwrote: exists };
}

// --- rm ---------------------------------------------------------------------

export type RemoveResult = MutationOutcome &
	(
		| { action: "alias-removed"; provider: ProviderId; alias: string; target: string }
		| { action: "needs-confirm"; provider: ProviderId; label: string; refresh: string }
		| { action: "stale"; provider: ProviderId; label: string; currentRefresh: string }
		| { action: "profile-removed"; provider: ProviderId; label: string; droppedAliases: string[]; clearedDefault: boolean }
	);

/**
 * `rm <selector>`: an alias is removed immediately; removing a profile is
 * destructive (grant is lost) and requires `confirmedProfileRemoval`.
 *
 * TOCTOU guard (T036): needs-confirm carries the profile's refresh-token
 * fingerprint. A confirmed removal passes it back as `expectedRefresh`; if the
 * grant changed while the user was staring at the prompt, the mutation is
 * rejected as `stale` and the caller re-asks against the new grant.
 */
export function removeSelection(
	store: SeatStore,
	selectorInput: string,
	options: { confirmedProfileRemoval?: boolean; expectedRefresh?: string } = {},
): RemoveResult {
	const selector = parseSelector(selectorInput);
	const sec = section(store, selector.provider);
	if (!sec) throw new CommandError(`no profile or alias "${selector.name}" for provider "${selector.provider}"`);

	const aliasTarget = own(sec.aliases, selector.name);
	if (aliasTarget !== undefined) {
		delete sec.aliases[selector.name];
		return { changed: true, action: "alias-removed", provider: selector.provider, alias: selector.name, target: aliasTarget };
	}

	const label = selector.name;
	const current = own(sec.profiles, label);
	if (current === undefined) {
		throw new CommandError(`no profile or alias "${label}" for provider "${selector.provider}"`);
	}
	if (!options.confirmedProfileRemoval) {
		return { changed: false, action: "needs-confirm", provider: selector.provider, label, refresh: current.refresh };
	}
	if (options.expectedRefresh !== undefined && options.expectedRefresh !== current.refresh) {
		return { changed: false, action: "stale", provider: selector.provider, label, currentRefresh: current.refresh };
	}

	delete sec.profiles[label];
	const droppedAliases: string[] = [];
	for (const alias of Object.keys(sec.aliases)) {
		if (sec.aliases[alias] === label) {
			droppedAliases.push(alias);
			delete sec.aliases[alias];
		}
	}
	let clearedDefault = false;
	if (sec.default === label) {
		delete sec.default;
		clearedDefault = true;
	}
	return { changed: true, action: "profile-removed", provider: selector.provider, label, droppedAliases: droppedAliases.sort(), clearedDefault };
}

// --- rename -----------------------------------------------------------------

export type RenameResult = MutationOutcome & {
	action: "renamed";
	provider: ProviderId;
	from: string;
	to: string;
	retargetedAliases: string[];
	retargetedDefault: boolean;
};

/** `rename <old-selector> <new-label>`: the old selector decides the provider. */
export function renameProfile(store: SeatStore, oldSelectorInput: string, newLabel: string): RenameResult {
	const selector = parseSelector(oldSelectorInput);
	if (newLabel === DEFAULT_KEYWORD) throw new CommandError(`"${DEFAULT_KEYWORD}" is a reserved name`);
	if (!isValidLabel(newLabel)) throw new CommandError(`invalid label "${newLabel}" (":" and "," are not allowed)`);

	const sec = section(store, selector.provider);
	const from = resolveName(sec, selector.name);
	if (from === undefined || !sec) {
		throw new CommandError(`no profile or alias "${selector.name}" for provider "${selector.provider}"`);
	}
	if (from === newLabel) throw new CommandError(`"${selector.name}" already resolves to "${newLabel}"`);
	if (own(sec.profiles, newLabel) !== undefined || own(sec.aliases, newLabel) !== undefined) {
		throw new CommandError(`"${newLabel}" already exists for provider "${selector.provider}"`);
	}

	const credential = own(sec.profiles, from);
	if (credential === undefined) throw new CommandError(`no profile "${from}" for provider "${selector.provider}"`);
	sec.profiles[newLabel] = credential;
	delete sec.profiles[from];

	const retargetedAliases: string[] = [];
	for (const alias of Object.keys(sec.aliases)) {
		if (sec.aliases[alias] === from) {
			sec.aliases[alias] = newLabel;
			retargetedAliases.push(alias);
		}
	}
	let retargetedDefault = false;
	if (sec.default === from) {
		sec.default = newLabel;
		retargetedDefault = true;
	}
	return { changed: true, action: "renamed", provider: selector.provider, from, to: newLabel, retargetedAliases: retargetedAliases.sort(), retargetedDefault };
}
