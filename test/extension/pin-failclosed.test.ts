import { afterEach, describe, expect, test } from "bun:test";
import type { SeatCredential } from "../../src/store/schema.ts";
import { cleanupLoadedExtensions, loadExtension, type LoadedExtension } from "./load-extension.ts";

const FRESH = Date.now() + 3_600_000;

function cred(refresh: string): SeatCredential {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires: FRESH };
}

afterEach(cleanupLoadedExtensions);

/** Anthropic-only seeding, which is all these fail-closed cases need. */
function load(pin: string, anthropic: Record<string, SeatCredential>): LoadedExtension {
	return loadExtension({ pin, profiles: { anthropic } });
}

async function assertFailClosed(loaded: LoadedExtension): Promise<void> {
	await loaded.fireSessionStart();
	expect(loaded.notices.some((n) => n.includes("PI_SEAT"))).toBe(true); // explicit startup notice

	await loaded.fireTurnStart();
	expect(loaded.aborts).toBe(1); // turn aborted
	expect(loaded.runtime.streamCalls).toBe(0); // provider stream never called
	expect(loaded.runtime.keys.size).toBe(0); // no credential overlay applied at all
}

describe("AC-004: PI_SEAT fail-closed at startup (T030)", () => {
	test("unknown label aborts the turn with a startup notice", async () => {
		await assertFailClosed(load("nosuch", { work: cred("rt-work") }));
	});

	test("malformed selector (dangling provider prefix) fails closed", async () => {
		await assertFailClosed(load("anthropic:", { work: cred("rt-work") }));
	});

	test("duplicate provider in multi-value pin fails closed", async () => {
		await assertFailClosed(load("anthropic:work,anthropic:work", { work: cred("rt-work") }));
	});

	test("no partial apply: one valid + one invalid entry applies neither pin", async () => {
		const loaded = load("anthropic:work,openai-codex:nosuch", { work: cred("rt-work") });
		await assertFailClosed(loaded);
		// Even the valid anthropic:work pin must not have been applied.
		expect(loaded.runtime.events.filter((e) => e.startsWith("set:"))).toEqual([]);
	});

	test("control: a valid pin applies and streams", async () => {
		const loaded = load("work", { work: cred("rt-work") });
		await loaded.fireSessionStart();
		await loaded.fireTurnStart();
		expect(loaded.aborts).toBe(0);
		expect(loaded.runtime.keys.get("anthropic")).toBe("at-rt-work");
		expect(loaded.runtime.streamCalls).toBe(1);
	});

	test("an unreadable store is not reported as a PI_SEAT problem", async () => {
		const loaded = loadExtension({ pin: "", corruptStore: true });
		await loaded.fireSessionStart();
		const notice = loaded.notices.join("\n");
		expect(notice).toContain("credential store could not be read");
		expect(notice).not.toContain("PI_SEAT is invalid");

		await loaded.fireTurnStart();
		expect(loaded.aborts).toBe(1); // still fails closed
		expect(loaded.runtime.streamCalls).toBe(0);
	});
});
