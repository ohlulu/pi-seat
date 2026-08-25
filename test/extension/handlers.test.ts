import { describe, expect, test } from "bun:test";
import { emptyStore, parseStore, type SeatCredential, type SeatStore } from "../../src/store/schema.ts";
import { serializeStore } from "../../src/store/schema.ts";
import {
	CommandError,
	loginProfile,
	removeSelection,
	renameProfile,
	runMutation,
	useSelection,
} from "../../src/extension/commands.ts";
import { InMemorySeatStorageBackend } from "../../src/store/storage.ts";

function cred(refresh: string): SeatCredential {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires: 1_900_000_000_000 };
}

function seeded(): SeatStore {
	const store = emptyStore();
	store.providers.anthropic = {
		default: "work",
		profiles: Object.assign(Object.create(null), { work: cred("rt-w"), personal: cred("rt-p") }),
		aliases: Object.assign(Object.create(null), { w: "work", p: "personal" }),
	};
	store.providers["openai-codex"] = {
		profiles: Object.assign(Object.create(null), { main: cred("rt-c") }),
		aliases: Object.assign(Object.create(null)),
	};
	return store;
}

/** Every handler mutation must leave a store that still parses cleanly. */
function assertValid(store: SeatStore): void {
	expect(() => parseStore(JSON.parse(serializeStore(store)))).not.toThrow();
}

describe("useSelection", () => {
	test("sets the provider default via label or alias (Python-compatible resolution)", () => {
		const store = seeded();
		const result = useSelection(store, "p");
		expect(result).toEqual({ changed: true, action: "set", provider: "anthropic", label: "personal", attachedAliases: [] });
		expect(store.providers.anthropic?.default).toBe("personal");
		assertValid(store);
	});

	test("`default` clears the provider default; clearing twice is a no-op", () => {
		const store = seeded();
		expect(useSelection(store, "default")).toEqual({ changed: true, action: "clear", provider: "anthropic" });
		expect(store.providers.anthropic?.default).toBeUndefined();
		expect(useSelection(store, "default").changed).toBe(false);
		expect(useSelection(store, "openai-codex:default").changed).toBe(false); // never had one
		assertValid(store);
	});

	test("re-selecting the current default reports no change", () => {
		const store = seeded();
		expect(useSelection(store, "work").changed).toBe(false);
		expect(useSelection(store, "w").changed).toBe(false); // alias of current default
	});

	test("unknown selector is an operation error", () => {
		expect(() => useSelection(seeded(), "nosuch")).toThrow(CommandError);
		expect(() => useSelection(seeded(), "openai-codex:nosuch")).toThrow(CommandError);
	});
});

describe("AC-017: use attaches aliases atomically with the default", () => {
	test("`use <label> -a <alias>` writes the default and the alias in one mutation", () => {
		const store = seeded();
		const result = useSelection(store, "personal", ["o", "me"]);
		expect(result).toEqual({
			changed: true,
			action: "set",
			provider: "anthropic",
			label: "personal",
			attachedAliases: ["o", "me"],
		});
		expect(store.providers.anthropic?.default).toBe("personal");
		expect(store.providers.anthropic?.aliases["o"]).toBe("personal");
		expect(store.providers.anthropic?.aliases["me"]).toBe("personal");
		// The attached alias is a real selector afterwards.
		expect(useSelection(store, "o")).toMatchObject({ action: "set", label: "personal" });
		assertValid(store);
	});

	test("attaching an alias is a change even when the default already points there", () => {
		const store = seeded();
		const result = useSelection(store, "work", ["day"]);
		expect(result.changed).toBe(true); // default unchanged, alias is new
		expect(store.providers.anthropic?.aliases["day"]).toBe("work");
		// Re-attaching the same alias to the same profile is a no-op.
		expect(useSelection(store, "work", ["day"])).toEqual({
			changed: false,
			action: "set",
			provider: "anthropic",
			label: "work",
			attachedAliases: [],
		});
		assertValid(store);
	});

	test("the selector may itself be an alias; the alias lands on the resolved label", () => {
		const store = seeded();
		useSelection(store, "p", ["pp"]);
		expect(store.providers.anthropic?.aliases["pp"]).toBe("personal");
		assertValid(store);
	});

	test("invalid or conflicting aliases are rejected with the store untouched", () => {
		const store = seeded();
		const before = serializeStore(store);
		expect(() => useSelection(store, "work", ["a:b"])).toThrow(/invalid alias/); // login's charset rule
		expect(() => useSelection(store, "work", ["a,b"])).toThrow(/invalid alias/);
		expect(() => useSelection(store, "work", ["default"])).toThrow(/reserved/);
		expect(() => useSelection(store, "work", ["personal"])).toThrow(/collides/); // alias = other profile
		expect(() => useSelection(store, "work", ["work"])).toThrow(/collides/); // alias = its own label
		expect(() => useSelection(store, "work", ["p"])).toThrow(/already points/); // owned by personal
		expect(() => useSelection(store, "default", ["o"])).toThrow(/no profile to alias/);
		// A partially-applied attachment would leave an alias without its default.
		expect(() => useSelection(store, "work", ["ok", "personal"])).toThrow(/collides/);
		expect(serializeStore(store)).toBe(before);
	});

	test("unknown selector with aliases still fails before any alias is written", () => {
		const store = seeded();
		expect(() => useSelection(store, "nosuch", ["n"])).toThrow(CommandError);
		expect(store.providers.anthropic?.aliases["n"]).toBeUndefined();
	});
});

describe("loginProfile", () => {
	test("stores a new profile with repeatable aliases", () => {
		const store = seeded();
		const result = loginProfile(store, "openai-codex:backup", cred("rt-b"), ["b", "bk"]);
		expect(result).toEqual({ changed: true, action: "stored", provider: "openai-codex", label: "backup", overwrote: false });
		expect(store.providers["openai-codex"]?.profiles["backup"]?.refresh).toBe("rt-b");
		expect(store.providers["openai-codex"]?.aliases).toEqual(
			Object.assign(Object.create(null), { b: "backup", bk: "backup" }),
		);
		assertValid(store);
	});

	test("overwrite requires confirm (AC-013): needs-confirm first, stored with flag", () => {
		const store = seeded();
		const first = loginProfile(store, "work", cred("rt-new"));
		expect(first).toEqual({ changed: false, action: "needs-confirm", provider: "anthropic", label: "work" });
		expect(store.providers.anthropic?.profiles["work"]?.refresh).toBe("rt-w"); // untouched

		const confirmed = loginProfile(store, "work", cred("rt-new"), [], { confirmedOverwrite: true });
		expect(confirmed).toEqual({ changed: true, action: "stored", provider: "anthropic", label: "work", overwrote: true });
		expect(store.providers.anthropic?.profiles["work"]?.refresh).toBe("rt-new");
		assertValid(store);
	});

	test("rejects reserved and malformed names, alias collisions", () => {
		const store = seeded();
		expect(() => loginProfile(store, "default", cred("x"))).toThrow(CommandError);
		expect(() => loginProfile(store, "anthropic:a,b", cred("x"))).toThrow(); // selector-level
		expect(() => loginProfile(store, "w", cred("x"))).toThrow(/alias/); // label collides with alias
		expect(() => loginProfile(store, "fresh", cred("x"), ["personal"])).toThrow(/collides/); // alias = profile name
		expect(() => loginProfile(store, "fresh", cred("x"), ["fresh"])).toThrow(/collides/); // alias = the new label itself
		expect(() => loginProfile(store, "fresh", cred("x"), ["w"])).toThrow(/already points/); // alias owned elsewhere
	});
});

describe("removeSelection", () => {
	test("rm distinguishes alias vs profile: alias goes immediately", () => {
		const store = seeded();
		const result = removeSelection(store, "w");
		expect(result).toEqual({ changed: true, action: "alias-removed", provider: "anthropic", alias: "w", target: "work" });
		expect(store.providers.anthropic?.profiles["work"]).toBeDefined(); // profile untouched
		assertValid(store);
	});

	test("profile removal is destructive: needs-confirm, then drops aliases and default", () => {
		const store = seeded();
		expect(removeSelection(store, "work")).toEqual({ changed: false, action: "needs-confirm", provider: "anthropic", label: "work", refresh: "rt-w" });

		const confirmed = removeSelection(store, "work", { confirmedProfileRemoval: true });
		expect(confirmed).toEqual({
			changed: true,
			action: "profile-removed",
			provider: "anthropic",
			label: "work",
			droppedAliases: ["w"],
			clearedDefault: true,
		});
		expect(store.providers.anthropic?.profiles["work"]).toBeUndefined();
		expect(store.providers.anthropic?.aliases["w"]).toBeUndefined();
		expect(store.providers.anthropic?.default).toBeUndefined();
		expect(store.providers.anthropic?.profiles["personal"]).toBeDefined(); // others survive
		assertValid(store);
	});

	test("unknown name is an operation error", () => {
		expect(() => removeSelection(seeded(), "nosuch")).toThrow(CommandError);
	});

	test("T036: confirmed removal with a stale fingerprint is rejected", () => {
		const store = seeded();
		const pre = removeSelection(store, "work");
		expect(pre.action).toBe("needs-confirm");
		if (pre.action !== "needs-confirm") throw new Error("unreachable");
		expect(pre.refresh).toBe("rt-w"); // fingerprint of the grant being confirmed

		// The grant is replaced between confirm and commit.
		store.providers.anthropic!.profiles["work"] = cred("rt-replaced");
		const stale = removeSelection(store, "work", { confirmedProfileRemoval: true, expectedRefresh: pre.refresh });
		expect(stale).toEqual({ changed: false, action: "stale", provider: "anthropic", label: "work", currentRefresh: "rt-replaced" });
		expect(store.providers.anthropic?.profiles["work"]?.refresh).toBe("rt-replaced"); // untouched

		// Re-confirmed against the current fingerprint → removal proceeds.
		const removed = removeSelection(store, "work", { confirmedProfileRemoval: true, expectedRefresh: "rt-replaced" });
		expect(removed.action).toBe("profile-removed");
		assertValid(store);
	});
});

describe("renameProfile", () => {
	test("rename retargets aliases and default; old selector may be an alias", () => {
		const store = seeded();
		const result = renameProfile(store, "w", "day");
		expect(result).toEqual({
			changed: true,
			action: "renamed",
			provider: "anthropic",
			from: "work",
			to: "day",
			retargetedAliases: ["w"],
			retargetedDefault: true,
		});
		expect(store.providers.anthropic?.profiles["day"]?.refresh).toBe("rt-w");
		expect(store.providers.anthropic?.profiles["work"]).toBeUndefined();
		expect(store.providers.anthropic?.aliases["w"]).toBe("day");
		expect(store.providers.anthropic?.default).toBe("day");
		assertValid(store);
	});

	test("rejects reserved, colliding, and unknown names", () => {
		expect(() => renameProfile(seeded(), "work", "default")).toThrow(CommandError);
		expect(() => renameProfile(seeded(), "work", "personal")).toThrow(/already exists/);
		expect(() => renameProfile(seeded(), "work", "p")).toThrow(/already exists/); // collides with alias
		expect(() => renameProfile(seeded(), "nosuch", "x")).toThrow(CommandError);
		expect(() => renameProfile(seeded(), "w", "work")).toThrow(/already resolves/);
	});
});

describe("runMutation", () => {
	test("commits only when the handler reports a change", () => {
		const backend = new InMemorySeatStorageBackend();
		runMutation(backend, (store) => loginProfile(store, "fresh", cred("rt-f")));
		const afterLogin = backend.read((c) => c);
		expect(afterLogin).toContain("rt-f");

		// needs-confirm mutates nothing and must not rewrite the file.
		runMutation(backend, (store) => loginProfile(store, "fresh", cred("rt-clobber")));
		expect(backend.read((c) => c)).toBe(afterLogin);
	});
});
