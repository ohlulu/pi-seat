/**
 * One-time migration from legacy claude-profiles.json (REQ-008).
 *
 * Runs on first extension load: IF seat.json does not exist AND the legacy
 * file does, import legacy anthropic profiles with three exclusion rules:
 *
 * 1. Unconditionally exclude the profile the legacy `active` label points to —
 *    Pi refresh rotates tokens, so byte-equality cannot recognize an already
 *    rotated active lineage.
 * 2. Additionally exclude any profile whose refresh token equals auth.json's
 *    current anthropic credential (that grant belongs to Pi's built-in login).
 * 3. `active` missing / dangling / comparison ambiguous → fail closed: import
 *    nothing, tell the user to run /seat login per account.
 *
 * The decision is made inside the store lock with the first-load condition
 * re-checked (DEC-003), and the legacy file is never written, chmodded, or
 * deleted — it stays untouched for rollback.
 */

import { isValidLabel, type SeatCredential, type SeatStore } from "./schema.ts";
import { decodeStore, encodeStore, readForeignFileNoFollow, type SeatStorageBackend } from "./storage.ts";

export type MigrationResult =
	| { outcome: "imported"; imported: string[]; excluded: string[]; notice: string }
	| { outcome: "noop"; reason: "store-exists" | "legacy-absent" | "legacy-empty" }
	| { outcome: "fail-closed"; reason: string; notice: string };

interface LegacyDocument {
	active: unknown;
	profiles: Record<string, unknown>;
	aliases: Record<string, unknown>;
}

const LOGIN_HINT = "Run `/seat login <label>` once per account to create named profiles.";

function own(obj: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLegacy(content: string): LegacyDocument | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!isPlainObject(raw)) return undefined;
	const profiles = own(raw, "profiles") ?? {};
	const aliases = own(raw, "aliases") ?? {};
	if (!isPlainObject(profiles) || !isPlainObject(aliases)) return undefined;
	return { active: own(raw, "active"), profiles, aliases };
}

/** A legacy credential usable for import: Pi OAuth shape with a refresh token. */
function toCredential(raw: unknown): SeatCredential | undefined {
	if (!isPlainObject(raw)) return undefined;
	const refresh = own(raw, "refresh");
	const access = own(raw, "access");
	const expires = own(raw, "expires");
	if (own(raw, "type") !== "oauth") return undefined;
	if (typeof refresh !== "string" || refresh.length === 0) return undefined;
	if (typeof access !== "string") return undefined;
	if (typeof expires !== "number" || !Number.isFinite(expires)) return undefined;
	const cred = Object.create(null) as SeatCredential;
	for (const key of Object.keys(raw)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
		Object.defineProperty(cred, key, { value: raw[key], enumerable: true, writable: true, configurable: true });
	}
	return cred;
}

/** auth.json's current anthropic refresh token, for the rule-2 comparison. */
function builtinAnthropicRefresh(authContent: string | undefined): { ok: true; refresh: string | undefined } | { ok: false } {
	if (authContent === undefined) return { ok: true, refresh: undefined };
	let raw: unknown;
	try {
		raw = JSON.parse(authContent);
	} catch {
		return { ok: false }; // unreadable auth.json → comparison ambiguous
	}
	if (!isPlainObject(raw)) return { ok: false };
	const anthropic = own(raw, "anthropic");
	if (anthropic === undefined) return { ok: true, refresh: undefined };
	if (!isPlainObject(anthropic)) return { ok: false };
	const refresh = own(anthropic, "refresh");
	if (refresh === undefined) return { ok: true, refresh: undefined };
	if (typeof refresh !== "string") return { ok: false };
	return { ok: true, refresh };
}

export interface MigrateOptions {
	backend: SeatStorageBackend;
	legacyPath: string;
	authPath: string;
}

export function migrateLegacyProfiles({ backend, legacyPath, authPath }: MigrateOptions): MigrationResult {
	// Cheap unlocked pre-check; the authoritative check re-runs inside the lock.
	const legacyContent = readForeignFileNoFollow(legacyPath);
	if (legacyContent === undefined) return { outcome: "noop", reason: "legacy-absent" };

	return backend.withLock<MigrationResult>((current) => {
		// Locked re-check (DEC-003): another process may have created the store
		// or removed the legacy file since the pre-check.
		if (current !== undefined) return { result: { outcome: "noop", reason: "store-exists" } };
		const lockedLegacy = readForeignFileNoFollow(legacyPath);
		if (lockedLegacy === undefined) return { result: { outcome: "noop", reason: "legacy-absent" } };

		const legacy = parseLegacy(lockedLegacy);
		if (!legacy) {
			return failClosed(`legacy file is not a recognizable claude-profiles.json: ${legacyPath}`);
		}
		const labels = Object.keys(legacy.profiles);
		if (labels.length === 0) return { result: { outcome: "noop", reason: "legacy-empty" } };

		// Rule 3 gates: the active pointer must name an existing profile.
		if (typeof legacy.active !== "string") {
			return failClosed("legacy `active` is missing — cannot identify the active lineage");
		}
		if (!Object.hasOwn(legacy.profiles, legacy.active)) {
			return failClosed(`legacy \`active\` points at a profile that does not exist: "${legacy.active}"`);
		}

		const builtin = builtinAnthropicRefresh(readForeignFileNoFollow(authPath));
		if (!builtin.ok) {
			return failClosed("auth.json is unreadable — refresh-token comparison is ambiguous");
		}

		const excluded = new Set<string>();
		const importable = Object.create(null) as Record<string, SeatCredential>;
		for (const label of labels) {
			const credential = toCredential(legacy.profiles[label]);
			if (!credential) {
				return failClosed(`legacy profile "${label}" is malformed — comparison is ambiguous`);
			}
			// Rule 1: the active lineage is excluded unconditionally.
			if (label === legacy.active) {
				excluded.add(label);
				continue;
			}
			// Rule 2: a profile sharing auth.json's grant is excluded independently.
			if (builtin.refresh !== undefined && credential.refresh === builtin.refresh) {
				excluded.add(label);
				continue;
			}
			if (!isValidLabel(label)) {
				return failClosed(`legacy label "${label}" is not a valid seat label`);
			}
			importable[label] = credential;
		}

		const imported = Object.keys(importable);
		const store: SeatStore = decodeStore(undefined);
		if (imported.length > 0) {
			const aliases = Object.create(null) as Record<string, string>;
			for (const alias of Object.keys(legacy.aliases)) {
				const target = legacy.aliases[alias];
				// Aliases follow their profile; those pointing at excluded or
				// missing profiles are dropped with it.
				if (typeof target !== "string" || !Object.hasOwn(importable, target)) continue;
				if (!isValidLabel(alias) || Object.hasOwn(importable, alias)) continue;
				aliases[alias] = target;
			}
			store.providers.anthropic = { profiles: importable, aliases };
		}

		const excludedList = [...excluded].sort();
		const notice =
			`Imported ${imported.length} dormant profile(s) from claude-profiles.json: ${imported.sort().join(", ") || "(none)"}. ` +
			(excludedList.length > 0
				? `Excluded (still usable via Pi's built-in login): ${excludedList.join(", ")}. ${LOGIN_HINT}`
				: "");

		return {
			result: { outcome: "imported", imported: imported.sort(), excluded: excludedList, notice },
			next: encodeStore(store),
		};
	});

	function failClosed(reason: string): { result: MigrationResult } {
		return {
			result: {
				outcome: "fail-closed",
				reason,
				notice: `seat migration skipped: ${reason}. Nothing was imported. ${LOGIN_HINT}`,
			},
		};
	}
}
