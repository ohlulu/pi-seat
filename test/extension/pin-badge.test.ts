/**
 * AC-026 wiring: the badge reaches Pi's footer through the real extension
 * entry. The formatter matrix lives in pin-status.test.ts; what is asserted
 * here is everything between it and ctx.ui — the status key, the theme
 * colour, the no-pin silence, and the re-set on every session_start.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SeatCredential } from "../../src/store/schema.ts";
import { cleanupLoadedExtensions, loadExtension } from "./load-extension.ts";

const FRESH = Date.now() + 3_600_000;

function cred(refresh: string): SeatCredential {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires: FRESH };
}

const PROFILES = {
	anthropic: { ula: cred("rt-ula") },
	"openai-codex": { work: cred("rt-work") },
} as const;

afterEach(cleanupLoadedExtensions);

describe("AC-026: pin badge wiring", () => {
	test("an anthropic pin sets the pi-seat key in accent styling", async () => {
		const loaded = loadExtension({ pin: "ula", profiles: PROFILES, hasUI: true });
		await loaded.fireSessionStart();
		expect(loaded.statuses.get("pi-seat")).toBe("<accent>:ula:</accent>");
	});

	test("a codex-only pin keeps the empty anthropic slot", async () => {
		const loaded = loadExtension({ pin: "openai-codex:work", profiles: PROFILES, hasUI: true });
		await loaded.fireSessionStart();
		expect(loaded.statuses.get("pi-seat")).toBe("<accent>:/work:</accent>");
	});

	test("both pins render in provider order", async () => {
		const loaded = loadExtension({ pin: "anthropic:ula,openai-codex:work", profiles: PROFILES, hasUI: true });
		await loaded.fireSessionStart();
		expect(loaded.statuses.get("pi-seat")).toBe("<accent>:ula/work:</accent>");
	});

	test("an alias resolves to its label before reaching the badge", async () => {
		const loaded = loadExtension({ pin: "ula", profiles: PROFILES, hasUI: true });
		await loaded.fireSessionStart();
		// Resolution happened at init; the badge never shows the raw selector.
		expect(loaded.statuses.get("pi-seat")).toContain(":ula:");
	});

	test("no pin sets no status at all (zero chrome)", async () => {
		const loaded = loadExtension({ pin: "", profiles: PROFILES, hasUI: true });
		await loaded.fireSessionStart();
		expect(loaded.statusCalls).toBe(0);
		expect(loaded.statuses.size).toBe(0);
	});

	test("invalid PI_SEAT sets the error badge in error styling", async () => {
		const loaded = loadExtension({ pin: "nosuch", profiles: PROFILES, hasUI: true });
		await loaded.fireSessionStart();
		expect(loaded.statuses.get("pi-seat")).toBe("<error>PI_SEAT invalid</error>");
	});

	test("an unreadable store gets its own badge, not the PI_SEAT one", async () => {
		const loaded = loadExtension({ pin: "", corruptStore: true, hasUI: true });
		await loaded.fireSessionStart();
		expect(loaded.statuses.get("pi-seat")).toBe("<error>seat store error</error>");
	});

	test("the badge is re-set on every session_start (/reload clears statuses)", async () => {
		const loaded = loadExtension({ pin: "ula", profiles: PROFILES, hasUI: true });
		await loaded.fireSessionStart();
		await loaded.fireSessionStart();
		expect(loaded.statusCalls).toBe(2);
		expect(loaded.statuses.get("pi-seat")).toBe("<accent>:ula:</accent>");
	});

	test("a per-turn auth failure leaves the badge untouched", async () => {
		// Pin resolves at init, then the profile is deleted: the turn fails
		// closed, but the pin identity the badge reports has not changed.
		const loaded = loadExtension({ pin: "ula", profiles: PROFILES, hasUI: true });
		await loaded.fireSessionStart();
		await loaded.fireTurnStart();
		expect(loaded.statusCalls).toBe(1); // turn_start never touches the badge
		expect(loaded.statuses.get("pi-seat")).toBe("<accent>:ula:</accent>");
	});

	test("no status surface (print mode, hasUI false) is not an error", async () => {
		const loaded = loadExtension({ pin: "ula", profiles: PROFILES, hasUI: false });
		await loaded.fireSessionStart();
		expect(loaded.statusCalls).toBe(0);
		expect(loaded.notices).toEqual([]); // silent, not a startup notice
	});
});
