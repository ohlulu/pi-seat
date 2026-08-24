/**
 * Selector grammar and selection resolution (REQ-002, REQ-003; DEC-002).
 *
 * Grammar, shared by every selector-taking command and PI_SEAT:
 * - A selector is `[provider:]label-or-alias`; a bare value means anthropic.
 * - Only recognized provider prefixes (`anthropic:`, `openai-codex:`) count as
 *   qualification; labels and aliases may not contain `:` or `,`.
 * - PI_SEAT: one bare value pins anthropic only; comma-separated multi-values
 *   must all be provider-qualified with no repeated provider.
 * - Any malformed / unknown-provider / duplicate-provider / unknown-label case
 *   is a hard error — fail closed at session startup, never partial-apply.
 *
 * Resolution order per provider: env pin > store default > Pi built-in.
 * Aliases are resolved to labels exactly once, at extension init (DEC-002);
 * a resolved label deleted mid-session fails closed at per-turn lookup.
 */

import { PROVIDER_IDS, isProviderId, type ProviderId, type ProviderSection, type SeatStore } from "./schema.ts";

export class SelectorError extends Error {
	override name = "SelectorError";
}

export interface ParsedSelector {
	provider: ProviderId;
	/** Unresolved name: a label or an alias. */
	name: string;
}

function assertValidName(name: string, context: string): void {
	if (name.length === 0) throw new SelectorError(`${context}: empty label`);
	if (name.includes(",")) throw new SelectorError(`${context}: "," is not allowed in a label or alias`);
	if (name.includes(":")) {
		const prefix = name.slice(0, name.indexOf(":"));
		throw new SelectorError(
			`${context}: unknown provider prefix "${prefix}:" (recognized: ${PROVIDER_IDS.join(", ")}); ":" is not allowed in a label or alias`,
		);
	}
}

/** Parse one `[provider:]label-or-alias` selector. */
export function parseSelector(input: string): ParsedSelector {
	const trimmed = input.trim();
	const colon = trimmed.indexOf(":");
	if (colon !== -1) {
		const prefix = trimmed.slice(0, colon);
		if (isProviderId(prefix)) {
			const name = trimmed.slice(colon + 1);
			assertValidName(name, `selector "${input}"`);
			return { provider: prefix, name };
		}
	}
	assertValidName(trimmed, `selector "${input}"`);
	return { provider: "anthropic", name: trimmed };
}

/**
 * Parse a PI_SEAT value into per-provider pin names (labels or aliases, not
 * yet resolved). Empty / whitespace-only means no pins.
 */
export function parsePinSpec(value: string): Partial<Record<ProviderId, string>> {
	const trimmed = value.trim();
	const pins: Partial<Record<ProviderId, string>> = {};
	if (trimmed.length === 0) return pins;

	const parts = trimmed.split(",");
	if (parts.length === 1) {
		// Single value: bare pins anthropic; a qualified single value is fine too.
		const selector = parseSelector(parts[0]!);
		pins[selector.provider] = selector.name;
		return pins;
	}

	for (const part of parts) {
		const piece = part.trim();
		if (piece.length === 0) throw new SelectorError(`PI_SEAT "${value}": empty entry in multi-value pin`);
		const colon = piece.indexOf(":");
		const prefix = colon === -1 ? undefined : piece.slice(0, colon);
		if (prefix === undefined || !isProviderId(prefix)) {
			throw new SelectorError(
				`PI_SEAT "${value}": every entry in a multi-value pin must be provider-qualified (got "${piece}")`,
			);
		}
		const name = piece.slice(colon + 1);
		assertValidName(name, `PI_SEAT entry "${piece}"`);
		if (pins[prefix] !== undefined) {
			throw new SelectorError(`PI_SEAT "${value}": provider "${prefix}" appears more than once`);
		}
		pins[prefix] = name;
	}
	return pins;
}

function readOwn<T>(map: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Resolve a name (label or alias) to a profile label within one provider. */
export function resolveName(section: ProviderSection | undefined, name: string): string | undefined {
	if (!section) return undefined;
	if (readOwn(section.profiles, name) !== undefined) return name;
	return readOwn(section.aliases, name);
}

/**
 * One-time init resolution of PI_SEAT (DEC-002): parse, resolve every alias to
 * its label, and verify every pinned profile exists. Any failure is a
 * SelectorError; the caller fails the session closed — never a partial pin set.
 */
export function resolvePins(store: SeatStore, pinSpec: string): Partial<Record<ProviderId, string>> {
	const names = parsePinSpec(pinSpec);
	const resolved: Partial<Record<ProviderId, string>> = {};
	for (const provider of PROVIDER_IDS) {
		const name = names[provider];
		if (name === undefined) continue;
		const label = resolveName(store.providers[provider], name);
		if (label === undefined) {
			throw new SelectorError(`PI_SEAT: no profile or alias "${name}" for provider "${provider}"`);
		}
		resolved[provider] = label;
	}
	return resolved;
}

export type Selection =
	| { source: "pin"; label: string }
	| { source: "default"; label: string }
	| { source: "builtin" };

/**
 * Per-provider selection: pin > store default > built-in. `pinnedLabel` is the
 * init-time resolved pin for this provider, if any.
 */
export function resolveSelection(store: SeatStore, provider: ProviderId, pinnedLabel: string | undefined): Selection {
	if (pinnedLabel !== undefined) return { source: "pin", label: pinnedLabel };
	const def = store.providers[provider]?.default;
	if (def !== undefined) return { source: "default", label: def };
	return { source: "builtin" };
}
