import { describe, expect, test } from "bun:test";
import {
	SchemaError,
	emptyStore,
	isValidLabel,
	parseStore,
	serializeStore,
	type SeatStore,
} from "../../src/store/schema.ts";
import { asOAuth } from "../helpers/credentials.ts";

function cred(refresh = "rt-1", access = "at-1", expires = 1_900_000_000_000) {
	return { type: "oauth", refresh, access, expires };
}

function validDoc(): unknown {
	return {
		version: 1,
		providers: {
			anthropic: {
				default: "work",
				profiles: { work: cred("rt-w"), personal: cred("rt-p") },
				aliases: { w: "work" },
			},
			"openai-codex": {
				profiles: { main: cred("rt-c") },
				aliases: {},
			},
		},
	};
}

describe("isValidLabel", () => {
	test("accepts ordinary labels", () => {
		for (const label of ["work", "personal", "工作", "a-b_c.d", "1"]) {
			expect(isValidLabel(label)).toBe(true);
		}
	});

	test("rejects selector metacharacters : and ,", () => {
		expect(isValidLabel("a:b")).toBe(false);
		expect(isValidLabel("a,b")).toBe(false);
	});

	test("rejects empty, padded, and prototype-machinery names", () => {
		for (const label of ["", " work", "work ", "__proto__", "constructor", "prototype"]) {
			expect(isValidLabel(label)).toBe(false);
		}
	});
});

describe("parseStore", () => {
	test("accepts a valid document and round-trips through serializeStore", () => {
		const store = parseStore(validDoc());
		expect(store.version).toBe(1);
		expect(store.providers.anthropic?.default).toBe("work");
		expect(asOAuth(store.providers.anthropic?.profiles["work"])?.refresh).toBe("rt-w");
		expect(store.providers.anthropic?.aliases["w"]).toBe("work");
		expect(asOAuth(store.providers["openai-codex"]?.profiles["main"])?.refresh).toBe("rt-c");

		const reparsed = parseStore(JSON.parse(serializeStore(store)));
		expect(reparsed).toEqual(store);
	});

	test("preserves extra credential fields (Pi OAuthCredential is open)", () => {
		const doc = validDoc() as Record<string, any>;
		doc.providers.anthropic.profiles.work.scopes = ["user:inference"];
		const store = parseStore(doc);
		expect(asOAuth(store.providers.anthropic?.profiles["work"])?.["scopes"]).toEqual(["user:inference"]);
	});

	test("rejects non-object roots and wrong version", () => {
		for (const bad of [null, [], "x", 42, { version: 2, providers: {} }, { providers: {} }]) {
			expect(() => parseStore(bad)).toThrow(SchemaError);
		}
	});

	test("rejects unknown top-level, provider, and section keys", () => {
		expect(() => parseStore({ version: 1, providers: {}, extra: true })).toThrow(SchemaError);
		expect(() => parseStore({ version: 1, providers: { gemini: { profiles: {} } } })).toThrow(SchemaError);
		const doc = validDoc() as Record<string, any>;
		doc.providers.anthropic.active = "work"; // legacy claude-profiles key must not sneak in
		expect(() => parseStore(doc)).toThrow(SchemaError);
	});

	test("rejects labels and aliases containing : or ,", () => {
		const withLabel = (label: string) => ({
			version: 1,
			providers: { anthropic: { profiles: { [label]: cred() }, aliases: {} } },
		});
		expect(() => parseStore(withLabel("a:b"))).toThrow(SchemaError);
		expect(() => parseStore(withLabel("a,b"))).toThrow(SchemaError);
		const doc = validDoc() as Record<string, any>;
		doc.providers.anthropic.aliases["x:y"] = "work";
		expect(() => parseStore(doc)).toThrow(SchemaError);
	});

	test("rejects dangling default and dangling or colliding aliases", () => {
		const dangling = validDoc() as Record<string, any>;
		dangling.providers.anthropic.default = "nosuch";
		expect(() => parseStore(dangling)).toThrow(SchemaError);

		const danglingAlias = validDoc() as Record<string, any>;
		danglingAlias.providers.anthropic.aliases.z = "nosuch";
		expect(() => parseStore(danglingAlias)).toThrow(SchemaError);

		const colliding = validDoc() as Record<string, any>;
		colliding.providers.anthropic.aliases.personal = "work";
		expect(() => parseStore(colliding)).toThrow(SchemaError);
	});

	test("rejects malformed credentials", () => {
		const noRefresh = validDoc() as Record<string, any>;
		delete noRefresh.providers.anthropic.profiles.work.refresh;
		expect(() => parseStore(noRefresh)).toThrow(SchemaError);

		const badType = validDoc() as Record<string, any>;
		badType.providers.anthropic.profiles.work.type = "api-key";
		expect(() => parseStore(badType)).toThrow(SchemaError);

		const badExpires = validDoc() as Record<string, any>;
		badExpires.providers.anthropic.profiles.work.expires = "soon";
		expect(() => parseStore(badExpires)).toThrow(SchemaError);
	});

	test("a JSON __proto__ key is rejected, never merged into prototypes", () => {
		// JSON.parse creates "__proto__" as an own property; parsing must refuse it.
		const doc = JSON.parse(
			`{"version":1,"providers":{"anthropic":{"profiles":{"__proto__":{"type":"oauth","refresh":"r","access":"a","expires":1}},"aliases":{}}}}`,
		);
		expect(() => parseStore(doc)).toThrow(SchemaError);

		const credDoc = JSON.parse(
			`{"version":1,"providers":{"anthropic":{"profiles":{"work":{"type":"oauth","refresh":"r","access":"a","expires":1,"__proto__":{"polluted":true}}},"aliases":{}}}}`,
		);
		expect(() => parseStore(credDoc)).toThrow(SchemaError);
		expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
	});

	test("parsed store uses null-prototype maps (no inherited lookups)", () => {
		const store = parseStore(validDoc());
		const profiles = store.providers.anthropic?.profiles as Record<string, unknown>;
		expect(Object.getPrototypeOf(profiles)).toBeNull();
		expect(profiles["toString"]).toBeUndefined();
	});
});

describe("emptyStore", () => {
	test("is a valid store", () => {
		const store: SeatStore = emptyStore();
		expect(parseStore(JSON.parse(serializeStore(store)))).toEqual(store);
	});
});

describe("REQ-013: api_key credentials", () => {
	const KEY = "sk-ant-api03-FAKE-test-key";

	function docWith(provider: string, credential: unknown): unknown {
		return { version: 1, providers: { [provider]: { profiles: { console: credential }, aliases: {} } } };
	}

	test("AC-040: an OAuth-only version-1 store round-trips byte-identical", () => {
		const text = serializeStore(parseStore(validDoc()));
		expect(serializeStore(parseStore(JSON.parse(text)))).toBe(text);
		expect(JSON.parse(text).version).toBe(1);
	});

	test("an anthropic api_key profile parses and round-trips beside OAuth profiles", () => {
		const doc = validDoc() as { providers: { anthropic: { profiles: Record<string, unknown> } } };
		doc.providers.anthropic.profiles["console"] = { type: "api_key", key: KEY };
		const store = parseStore(doc);
		expect(store.version).toBe(1);
		expect(store.providers.anthropic?.profiles["console"]).toEqual({ type: "api_key", key: KEY });
		expect(asOAuth(store.providers.anthropic?.profiles["work"])?.refresh).toBe("rt-w");
		expect(parseStore(JSON.parse(serializeStore(store)))).toEqual(store);
	});

	test("AC-040: openai-codex refuses an api_key credential", () => {
		expect(() => parseStore(docWith("openai-codex", { type: "api_key", key: KEY }))).toThrow(
			'provider "openai-codex" does not accept api_key credentials',
		);
	});

	test("a malformed api_key credential is refused", () => {
		for (const bad of [
			{ type: "api_key" },
			{ type: "api_key", key: "" },
			{ type: "api_key", key: 42 },
			{ type: "api_key", key: "sk-ant-api03-has space" },
			{ type: "api_key", key: "sk-ant-api03-line\nbreak" },
			{ type: "api_key", key: KEY, refresh: "rt" },
		]) {
			expect(() => parseStore(docWith("anthropic", bad))).toThrow(SchemaError);
		}
	});

	test("an unknown credential type names both accepted types", () => {
		expect(() => parseStore(docWith("anthropic", { type: "bearer", key: KEY }))).toThrow('must be "oauth" or "api_key"');
	});
});
