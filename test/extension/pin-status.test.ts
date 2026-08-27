import { describe, expect, test } from "bun:test";
import { pinBadge } from "../../src/extension/pin-status.ts";

describe("pin badge (AC-026)", () => {
	test("anthropic-only pin: bare label", () => {
		expect(pinBadge({ anthropic: "ula" }, false)).toEqual({ kind: "pin", text: ":ula:" });
	});

	test("codex-only pin keeps the leading slash marking the empty anthropic slot", () => {
		expect(pinBadge({ "openai-codex": "work" }, false)).toEqual({ kind: "pin", text: ":/work:" });
	});

	test("both pins render in PROVIDER_IDS order", () => {
		expect(pinBadge({ anthropic: "ula", "openai-codex": "work" }, false)).toEqual({
			kind: "pin",
			text: ":ula/work:",
		});
	});

	test("no pin renders zero chrome", () => {
		expect(pinBadge({}, false)).toBeUndefined();
	});

	test("invalid PI_SEAT renders the error badge even with no resolved pins", () => {
		expect(pinBadge({}, true)).toEqual({ kind: "error", text: "PI_SEAT invalid" });
	});
});
