/**
 * The usage walk's two concurrency constraints (DEC-011). They pull in
 * opposite directions, so both need pinning:
 *
 * - Credential preparation MUST be serial. It takes the store lock, and
 *   `backend.read` acquires that lock with a SYNCHRONOUS Atomics.wait spin
 *   while `withLockAsync` holds it across a refresh round trip. Overlapping
 *   two of them self-deadlocks the process.
 * - Usage endpoint calls MUST be concurrent. They are the entire latency of
 *   the report; serializing them makes total time the sum of every round trip.
 *
 * These use a REAL FileSeatStorageBackend on purpose. The deadlock is a
 * property of the file lock, so an InMemorySeatStorageBackend — which every
 * other collectUsage test uses — cannot observe it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStore, type SeatOAuthCredential } from "../../src/store/schema.ts";
import { FileSeatStorageBackend, decodeStore, encodeStore } from "../../src/store/storage.ts";
import type { RefreshCallback } from "../../src/store/refresh.ts";
import { createStoreSchedule } from "../../src/store/scheduler.ts";
import { API_KEY_BALANCE_LINK, API_KEY_USAGE_HINT, CONSOLE_BILLING_URL, collectUsage, isLive, renderAccountBlock, usageSections } from "../../src/usage/report.ts";
import { planLayout } from "../../src/usage/layout.ts";
import { visibleCellWidth } from "../../src/usage/cells.ts";
import { asOAuth } from "../helpers/credentials.ts";

const CLAUDE_PAYLOAD = { limits: [{ kind: "session", percent: 42, resets_at: "2026-01-15T14:31:00+00:00" }] };

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expired(tag: string): SeatOAuthCredential {
	return { type: "oauth", refresh: `rt-${tag}`, access: `at-${tag}`, expires: Date.now() - 60_000 };
}

function fresh(tag: string): SeatOAuthCredential {
	return { type: "oauth", refresh: `rt-${tag}`, access: `at-${tag}`, expires: Date.now() + 3_600_000 };
}

/** Real on-disk store with a real lock; `auth.json` deliberately absent. */
function seed(profiles: Record<string, SeatOAuthCredential>, defaultLabel: string) {
	const dir = mkdtempSync(join(tmpdir(), "seat-report-"));
	dirs.push(dir);
	const storePath = join(dir, "seat.json");
	const store = emptyStore();
	store.providers.anthropic = {
		default: defaultLabel,
		profiles: Object.assign(Object.create(null), profiles),
		aliases: Object.assign(Object.create(null)),
	};
	const backend = new FileSeatStorageBackend(storePath);
	backend.withLock(() => ({ result: undefined, next: encodeStore(store) }));
	return { backend, authPath: join(dir, "auth.json") };
}

describe("collectUsage concurrency (DEC-011)", () => {
	test("a slow refresh on one profile does not lock out the accounts after it", async () => {
		const { backend, authPath } = seed({ stale: expired("stale"), other: fresh("other") }, "stale");

		const server = Bun.serve({ port: 0, fetch: () => Response.json(CLAUDE_PAYLOAD) });
		const claudeUrl = `http://localhost:${server.port}/claude`;

		// Long enough that a concurrent synchronous lock acquire would spin on
		// Atomics.wait and starve this callback's own timer.
		const refresh: RefreshCallback = async (credential) => {
			await Bun.sleep(300);
			return { ...credential, access: "at-rotated", expires: Date.now() + 3_600_000 };
		};

		const started = Date.now();
		const accounts = await collectUsage({
			backend,
			store: backend.read((current) => decodeStore(current)),
			authPath,
			pins: {},
			refreshFor: () => refresh,
			fetchOptions: { claudeUrl },
		});
		const elapsed = Date.now() - started;
		await server.stop(true);

		expect(accounts.map((a) => a.name)).toEqual(["stale", "other"]);
		for (const account of accounts) {
			const hint = account.result.ok ? "" : account.result.hint;
			expect(hint).not.toContain("Lock file is already being held");
			expect(account.result.ok).toBe(true);
		}
		// The sync-lock timeout is 5s per acquire; the deadlock this guards
		// against burned two of them.
		expect(elapsed).toBeLessThan(2_000);
	});

	test("a store read scheduled during the walk's refresh waits for it instead of deadlocking (DEC-013)", async () => {
		const { backend, authPath } = seed({ stale: expired("stale") }, "stale");
		const schedule = createStoreSchedule();
		const server = Bun.serve({ port: 0, fetch: () => Response.json(CLAUDE_PAYLOAD) });
		let onTheWire!: () => void;
		const wire = new Promise<void>((resolve) => {
			onTheWire = resolve;
		});
		const refresh: RefreshCallback = async (credential) => {
			onTheWire();
			await Bun.sleep(300);
			return { ...credential, access: "at-rotated", expires: Date.now() + 3_600_000 };
		};

		const walk = collectUsage({
			backend,
			store: backend.read((current) => decodeStore(current)),
			authPath,
			pins: {},
			refreshFor: () => refresh,
			fetchOptions: { claudeUrl: `http://localhost:${server.port}/claude` },
			schedule,
		});
		await wire; // the walk now holds the store lock across its refresh
		// What a subagent child's request does on the same schedule meanwhile.
		const started = Date.now();
		const store = await schedule(() => backend.read((current) => decodeStore(current)));
		const elapsed = Date.now() - started;
		await walk;
		await server.stop(true);

		expect(asOAuth(store.providers.anthropic?.profiles["stale"])?.access).toBe("at-rotated"); // it ran after the commit
		expect(elapsed).toBeLessThan(2_000); // a sync-lock deadlock waits out the 5s timeout
	});

	test("usage endpoints for different accounts are in flight at the same time", async () => {
		const { backend, authPath } = seed({ a: fresh("a"), b: fresh("b"), c: fresh("c") }, "a");

		let inFlight = 0;
		let peak = 0;
		const server = Bun.serve({
			port: 0,
			fetch: async () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await Bun.sleep(80);
				inFlight -= 1;
				return Response.json(CLAUDE_PAYLOAD);
			},
		});

		const accounts = await collectUsage({
			backend,
			store: backend.read((current) => decodeStore(current)),
			authPath,
			pins: {},
			refreshFor: () => async (c) => c,
			fetchOptions: { claudeUrl: `http://localhost:${server.port}/claude` },
		});
		await server.stop(true);

		expect(accounts).toHaveLength(3);
		// Serial would peak at 1 and take ~240ms; concurrent overlaps all three.
		expect(peak).toBe(3);
	});

	test("the effective selection still leads its section and is emitted first", async () => {
		const { backend, authPath } = seed({ alpha: fresh("alpha"), beta: fresh("beta") }, "beta");

		const server = Bun.serve({ port: 0, fetch: () => Response.json(CLAUDE_PAYLOAD) });
		const emitted: string[] = [];
		const accounts = await collectUsage(
			{
				backend,
				store: backend.read((current) => decodeStore(current)),
				authPath,
				pins: {},
				refreshFor: () => async (c) => c,
				fetchOptions: { claudeUrl: `http://localhost:${server.port}/claude` },
			},
			(account) => emitted.push(account.name),
		);
		await server.stop(true);

		// "beta" is the default, so it leads despite "alpha" coming first in the
		// store's own key order.
		expect(emitted).toEqual(["beta", "alpha"]);
		expect(accounts.map((a) => a.name)).toEqual(emitted);
	});
});

describe("AC-044: an API-key profile in the walk (REQ-013)", () => {
	test("renders a no-meter row without preparing or fetching it, and still takes the live dot", async () => {
		const { backend, authPath } = seed({ work: fresh("work") }, "work");
		backend.withLock((current) => {
			const store = decodeStore(current);
			store.providers.anthropic!.profiles["console"] = { type: "api_key", key: "sk-ant-api03-FAKE-report" };
			store.providers.anthropic!.default = "console";
			return { result: undefined, next: encodeStore(store) };
		});
		const store = backend.read((current) => decodeStore(current));
		const refreshed: string[] = [];
		const fetched: string[] = [];

		const accounts = await collectUsage({
			backend,
			store,
			authPath,
			pins: {},
			refreshFor: () => async (c) => {
				refreshed.push(c.refresh);
				return c;
			},
			fetchOptions: {
				fetchImpl: (async (_url: string, init?: RequestInit) => {
					fetched.push((init?.headers as Record<string, string>)["Authorization"] ?? "");
					return Response.json(CLAUDE_PAYLOAD);
				}) as unknown as typeof fetch,
			},
		});

		const anthropic = accounts.filter((a) => a.provider === "anthropic");
		expect(anthropic.map((a) => a.name)).toEqual(["console", "work"]); // the selection leads
		expect(anthropic[0]).toMatchObject({
			note: "API key",
			result: { ok: false, hint: API_KEY_USAGE_HINT, failed: false, unmetered: true, link: { text: API_KEY_BALANCE_LINK.text, href: CONSOLE_BILLING_URL } },
		});
		expect(fetched).toEqual(["Bearer at-work"]); // only the OAuth profile hit the endpoint
		expect(refreshed).toEqual([]);

		const sections = usageSections(store, {});
		const block = renderAccountBlock(planLayout(80), anthropic[0]!, { color: false, now: () => new Date() }, isLive(sections, anthropic[0]!));
		expect(block[0]).toContain("● console");
		expect(block[1]).toContain("no plan meters");
		expect(block[2]?.trim()).toBe("balance: platform.claude.com/settings/billing");
		expect(block.join("\n")).not.toContain("sk-ant-");
		expect(block.join("\n")).not.toContain("\x1b]8;"); // no color, no link escapes

		// With color, the hint is an OSC 8 link to the billing page and still fits its row.
		const linked = renderAccountBlock(planLayout(80), anthropic[0]!, { color: true, now: () => new Date() }, true);
		expect(linked[1]).not.toContain("\x1b]8;");
		expect(linked[2]).toContain(`\x1b]8;;${CONSOLE_BILLING_URL}\x07`);

		// AC-044: the plain URL survives a narrow terminal on its own row.
		const narrow = renderAccountBlock(planLayout(50), anthropic[0]!, { color: false, now: () => new Date() }, true);
		expect(narrow[2]).toContain("platform.claude.com/settings/billing");
		for (const width of [8, 20, 40, 80, 120]) {
			const rows = renderAccountBlock(planLayout(width), anthropic[0]!, { color: true, now: () => new Date() }, true);
			for (const row of rows) expect(visibleCellWidth(row)).toBeLessThanOrEqual(width);
		}
	});
});

