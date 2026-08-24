import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStore } from "../../src/store/schema.ts";

const WORKER = new URL("./lock-worker.ts", import.meta.url).pathname;

function tempStorePath(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "seat-lock-"));
	return { dir, path: join(dir, "seat.json") };
}

async function runWorkers(storePath: string, labels: string[], holdMs: number): Promise<void> {
	const procs = labels.map((label) =>
		Bun.spawn(["bun", WORKER, storePath, label, String(holdMs)], {
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	const exits = await Promise.all(procs.map((p) => p.exited));
	for (const [i, code] of exits.entries()) {
		if (code !== 0) {
			const err = await new Response(procs[i]!.stderr).text();
			throw new Error(`worker ${labels[i]} exited ${code}: ${err}`);
		}
	}
}

function storedLabels(storePath: string): string[] {
	const store = parseStore(JSON.parse(readFileSync(storePath, "utf8")));
	return Object.keys(store.providers.anthropic?.profiles ?? {}).sort();
}

describe("cross-process lock (AC-009 substrate)", () => {
	test("two real OS processes contend on an existing store — no lost update", async () => {
		const { dir, path } = tempStorePath();
		try {
			await runWorkers(path, ["seed"], 0);
			expect(storedLabels(path)).toEqual(["seed"]);

			// Hold the lock long enough that the two workers must overlap.
			await runWorkers(path, ["alpha", "beta"], 400);
			expect(storedLabels(path)).toEqual(["alpha", "beta", "seed"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("first-create under contention — both writes land, file is 0600", async () => {
		const { dir, path } = tempStorePath();
		try {
			expect(existsSync(path)).toBe(false);
			await runWorkers(path, ["alpha", "beta"], 300);
			expect(storedLabels(path)).toEqual(["alpha", "beta"]);
			expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("stale lock from a dead process is taken over", async () => {
		const { dir, path } = tempStorePath();
		try {
			writeFileSync(path, `{"version":1,"providers":{}}`, { mode: 0o600 });
			// proper-lockfile's lock is a directory whose mtime marks liveness.
			// A dead process leaves it behind; age it past LOCK_STALE_MS (30s).
			const lockDir = `${path}.lock`;
			mkdirSync(lockDir);
			const past = new Date(Date.now() - 60_000);
			utimesSync(lockDir, past, past);

			await runWorkers(path, ["takeover"], 0);
			expect(storedLabels(path)).toEqual(["takeover"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("a fresh (non-stale) foreign lock blocks until released", async () => {
		const { dir, path } = tempStorePath();
		try {
			writeFileSync(path, `{"version":1,"providers":{}}`, { mode: 0o600 });
			const lockDir = `${path}.lock`;
			mkdirSync(lockDir); // fresh mtime = held by a live process

			const worker = Bun.spawn(["bun", WORKER, path, "blocked", "0"], { stdout: "pipe", stderr: "pipe" });
			// Give the worker time to start contending, then release the lock.
			await Bun.sleep(500);
			expect(worker.killed).toBe(false);
			rmSync(lockDir, { recursive: true, force: true });
			expect(await worker.exited).toBe(0);
			expect(storedLabels(path)).toEqual(["blocked"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
