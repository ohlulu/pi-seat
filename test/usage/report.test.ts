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
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";
import { FileSeatStorageBackend, decodeStore, encodeStore } from "../../src/store/storage.ts";
import type { RefreshCallback } from "../../src/store/refresh.ts";
import { collectUsage } from "../../src/usage/report.ts";

const CLAUDE_PAYLOAD = { limits: [{ kind: "session", percent: 42, resets_at: "2026-01-15T14:31:00+00:00" }] };

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expired(tag: string): SeatCredential {
	return { type: "oauth", refresh: `rt-${tag}`, access: `at-${tag}`, expires: Date.now() - 60_000 };
}

function fresh(tag: string): SeatCredential {
	return { type: "oauth", refresh: `rt-${tag}`, access: `at-${tag}`, expires: Date.now() + 3_600_000 };
}

/** Real on-disk store with a real lock; `auth.json` deliberately absent. */
function seed(profiles: Record<string, SeatCredential>, defaultLabel: string) {
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
