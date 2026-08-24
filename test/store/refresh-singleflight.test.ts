import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";
import {
	RefreshTimeoutError,
	ensureFreshProfile,
	type RefreshCallback,
} from "../../src/store/refresh.ts";
import { FileSeatStorageBackend, encodeStore } from "../../src/store/storage.ts";

const WORKER = new URL("./refresh-worker.ts", import.meta.url).pathname;

function expiredCred(): SeatCredential {
	return { type: "oauth", refresh: "rt-expired", access: "at-old", expires: Date.now() - 60_000 };
}

function seedStore(path: string, credential: SeatCredential): void {
	const store = emptyStore();
	store.providers.anthropic = {
		profiles: Object.assign(Object.create(null), { work: credential }),
		aliases: Object.assign(Object.create(null)),
	};
	new FileSeatStorageBackend(path).withLock(() => ({ result: undefined, next: encodeStore(store) }));
}

describe("single-flight refresh (AC-009)", () => {
	test("two OS processes refreshing the same expired credential hit the endpoint exactly once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "seat-refresh-"));
		const storePath = join(dir, "seat.json");
		let hits = 0;
		const server = Bun.serve({
			port: 0,
			fetch: async () => {
				hits += 1;
				// Hold the response so both workers are provably in flight together.
				await Bun.sleep(250);
				return Response.json({ access: "at-rotated", refresh: "rt-rotated", expires: Date.now() + 3_600_000 });
			},
		});
		try {
			seedStore(storePath, expiredCred());
			const url = `http://localhost:${server.port}/token`;
			const procs = [1, 2].map(() => Bun.spawn(["bun", WORKER, storePath, url], { stdout: "pipe", stderr: "pipe" }));
			const exits = await Promise.all(procs.map((p) => p.exited));
			for (const [i, code] of exits.entries()) {
				if (code !== 0) throw new Error(`worker ${i} exited ${code}: ${await new Response(procs[i]!.stderr).text()}`);
			}
			const outputs = await Promise.all(
				procs.map(async (p) => JSON.parse(await new Response(p.stdout).text()) as { refresh: string; refreshed: boolean }),
			);

			expect(hits).toBe(1); // the endpoint saw exactly one refresh
			expect(outputs.map((o) => o.refresh)).toEqual(["rt-rotated", "rt-rotated"]); // same rotated credential
			expect(outputs.map((o) => o.refreshed).sort()).toEqual([false, true]); // one refreshed, one read the rotation

			const persisted = readFileSync(storePath, "utf8");
			expect(persisted).toContain("rt-rotated");
			expect(persisted).not.toContain("rt-expired");
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("lost response: timeout keeps the store byte-identical; the next attempt proceeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "seat-refresh-"));
		const storePath = join(dir, "seat.json");
		try {
			seedStore(storePath, expiredCred());
			const before = readFileSync(storePath);
			const backend = new FileSeatStorageBackend(storePath);

			const hanging: RefreshCallback = (_cred, signal) =>
				new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
			await expect(
				ensureFreshProfile(backend, "anthropic", "work", hanging, { timeoutMs: 100 }),
			).rejects.toBeInstanceOf(RefreshTimeoutError);
			expect(readFileSync(storePath).equals(before)).toBe(true); // old credential retained, byte-identical

			// Next attempt re-sends the same token and succeeds.
			const working: RefreshCallback = async (cred) => {
				expect(cred.refresh).toBe("rt-expired"); // same token re-sent
				return { type: "oauth", refresh: "rt-rotated-2", access: "at-2", expires: Date.now() + 3_600_000 };
			};
			const outcome = await ensureFreshProfile(backend, "anthropic", "work", working);
			expect(outcome.refreshed).toBe(true);
			expect(outcome.credential.refresh).toBe("rt-rotated-2");
			expect(readFileSync(storePath, "utf8")).toContain("rt-rotated-2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);
});
