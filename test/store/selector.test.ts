import { describe, expect, test } from "bun:test";
import { emptyStore, type SeatCredential, type SeatStore } from "../../src/store/schema.ts";
import {
	SelectorError,
	parsePinSpec,
	parseSelector,
	resolveName,
	resolvePins,
	resolveSelection,
} from "../../src/store/selector.ts";

function cred(refresh: string): SeatCredential {
	return { type: "oauth", refresh, access: "at", expires: 1_900_000_000_000 };
}

function storeWith(config: {
	anthropic?: { default?: string; profiles: string[]; aliases?: Record<string, string> };
	codex?: { default?: string; profiles: string[]; aliases?: Record<string, string> };
}): SeatStore {
	const store = emptyStore();
	for (const [provider, section] of [
		["anthropic", config.anthropic],
		["openai-codex", config.codex],
	] as const) {
		if (!section) continue;
		const profiles = Object.create(null) as Record<string, SeatCredential>;
		for (const label of section.profiles) profiles[label] = cred(`rt-${label}`);
		const aliases = Object.assign(Object.create(null), section.aliases ?? {});
		store.providers[provider] = section.default !== undefined
			? { default: section.default, profiles, aliases }
			: { profiles, aliases };
	}
	return store;
}

describe("parseSelector (grammar matrix)", () => {
	test("bare value targets anthropic", () => {
		expect(parseSelector("work")).toEqual({ provider: "anthropic", name: "work" });
		expect(parseSelector("  work  ")).toEqual({ provider: "anthropic", name: "work" });
	});

	test("recognized provider prefixes qualify", () => {
		expect(parseSelector("anthropic:work")).toEqual({ provider: "anthropic", name: "work" });
		expect(parseSelector("openai-codex:main")).toEqual({ provider: "openai-codex", name: "main" });
	});

	test("unknown prefix is a parse error, not a label", () => {
		expect(() => parseSelector("gemini:x")).toThrow(SelectorError);
		expect(() => parseSelector("gemini:x")).toThrow(/gemini/);
	});

	test("malformed selectors: empty, bare colon suffix, comma", () => {
		expect(() => parseSelector("")).toThrow(SelectorError);
		expect(() => parseSelector("   ")).toThrow(SelectorError);
		expect(() => parseSelector("anthropic:")).toThrow(SelectorError);
		expect(() => parseSelector("a,b")).toThrow(SelectorError);
		expect(() => parseSelector("anthropic:a,b")).toThrow(SelectorError);
	});
});

describe("parsePinSpec (PI_SEAT rules)", () => {
	test("empty and whitespace-only mean no pins", () => {
		expect(parsePinSpec("")).toEqual({});
		expect(parsePinSpec("   ")).toEqual({});
	});

	test("single bare value pins anthropic only", () => {
		expect(parsePinSpec("work")).toEqual({ anthropic: "work" });
	});

	test("single qualified value pins its provider", () => {
		expect(parsePinSpec("openai-codex:main")).toEqual({ "openai-codex": "main" });
	});

	test("multi-value: all entries must be provider-qualified", () => {
		expect(parsePinSpec("anthropic:work,openai-codex:main")).toEqual({
			anthropic: "work",
			"openai-codex": "main",
		});
		expect(() => parsePinSpec("anthropic:work,personal")).toThrow(SelectorError);
		expect(() => parsePinSpec("work,personal")).toThrow(SelectorError);
	});

	test("duplicate provider is an error", () => {
		expect(() => parsePinSpec("anthropic:a,anthropic:b")).toThrow(/more than once/);
	});

	test("unknown provider and empty entries are errors", () => {
		expect(() => parsePinSpec("gemini:x,anthropic:a")).toThrow(SelectorError);
		expect(() => parsePinSpec("anthropic:a,")).toThrow(SelectorError);
		expect(() => parsePinSpec("anthropic:a,,openai-codex:b")).toThrow(SelectorError);
	});
});

describe("resolveName", () => {
	const store = storeWith({ anthropic: { profiles: ["work"], aliases: { w: "work" } } });

	test("labels resolve to themselves, aliases to their target", () => {
		expect(resolveName(store.providers.anthropic, "work")).toBe("work");
		expect(resolveName(store.providers.anthropic, "w")).toBe("work");
	});

	test("unknown names and missing sections resolve to undefined", () => {
		expect(resolveName(store.providers.anthropic, "nosuch")).toBeUndefined();
		expect(resolveName(undefined, "work")).toBeUndefined();
	});
});

describe("resolvePins (init-time, fail-closed)", () => {
	const store = storeWith({
		anthropic: { profiles: ["work", "personal"], aliases: { w: "work" } },
		codex: { profiles: ["main"] },
	});

	test("aliases resolve once to labels", () => {
		expect(resolvePins(store, "w")).toEqual({ anthropic: "work" });
		expect(resolvePins(store, "anthropic:w,openai-codex:main")).toEqual({
			anthropic: "work",
			"openai-codex": "main",
		});
	});

	test("unknown label fails closed with no partial result", () => {
		expect(() => resolvePins(store, "nosuch")).toThrow(SelectorError);
		// Valid anthropic pin + invalid codex pin → whole spec rejected.
		expect(() => resolvePins(store, "anthropic:work,openai-codex:nosuch")).toThrow(SelectorError);
	});

	test("grammar errors propagate", () => {
		expect(() => resolvePins(store, "anthropic:a,anthropic:b")).toThrow(SelectorError);
	});
});

describe("resolveSelection (pin > default > builtin)", () => {
	const store = storeWith({
		anthropic: { default: "personal", profiles: ["work", "personal"] },
		codex: { profiles: ["main"] },
	});

	test("pin wins over default", () => {
		expect(resolveSelection(store, "anthropic", "work")).toEqual({ source: "pin", label: "work" });
	});

	test("default applies when unpinned", () => {
		expect(resolveSelection(store, "anthropic", undefined)).toEqual({ source: "default", label: "personal" });
	});

	test("builtin when neither pin nor default", () => {
		expect(resolveSelection(store, "openai-codex", undefined)).toEqual({ source: "builtin" });
		expect(resolveSelection(emptyStore(), "anthropic", undefined)).toEqual({ source: "builtin" });
	});

	test("per-provider independence: codex pin does not affect anthropic", () => {
		expect(resolveSelection(store, "openai-codex", "main")).toEqual({ source: "pin", label: "main" });
		expect(resolveSelection(store, "anthropic", undefined)).toEqual({ source: "default", label: "personal" });
	});
});
