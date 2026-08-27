import { describe, expect, test } from "bun:test";
import { pinBadge } from "../../src/extension/pin-status.ts";

describe("pin badge (AC-026)", () => {
	test("anthropic-only pin: bare label", () => {
		expect(pinBadge({ anthropic: "ula" })).toEqual({ kind: "pin", text: ":ula:" });
	});

	test("codex-only pin keeps the leading slash marking the empty anthropic slot", () => {
		expect(pinBadge({ "openai-codex": "work" })).toEqual({ kind: "pin", text: ":/work:" });
	});

	test("both pins render in PROVIDER_IDS order", () => {
		expect(pinBadge({ anthropic: "ula", "openai-codex": "work" })).toEqual({
			kind: "pin",
			text: ":ula/work:",
		});
	});

	test("no pin renders zero chrome", () => {
		expect(pinBadge({})).toBeUndefined();
	});

	test("invalid PI_SEAT renders the error badge even with no resolved pins", () => {
		expect(pinBadge({}, "pin-invalid")).toEqual({ kind: "error", text: "PI_SEAT invalid" });
	});

	test("an unreadable store is a distinct badge from an invalid pin", () => {
		expect(pinBadge({}, "store-unreadable")).toEqual({ kind: "error", text: "seat store error" });
	});

	// "/" is the slot delimiter but a legal label character (isValidLabel only
	// forbids ":" and ","), so an unescaped label would collide with a two-pin
	// badge and misreport which providers are pinned.
	test("a label containing the slot delimiter cannot be read as two pins", () => {
		const single = pinBadge({ anthropic: "ula/work" });
		const double = pinBadge({ anthropic: "ula", "openai-codex": "work" });
		expect(single).toEqual({ kind: "pin", text: ":ula\\/work:" });
		expect(single!.text).not.toBe(double!.text);
	});

	test("a backslash in a label is escaped so the escape itself stays unambiguous", () => {
		expect(pinBadge({ anthropic: "a\\b" })).toEqual({ kind: "pin", text: ":a\\\\b:" });
	});
});
