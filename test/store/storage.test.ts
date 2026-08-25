import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";
import {
	FileSeatStorageBackend,
	decodeStore,
	defaultSeatStorePath,
	encodeStore,
	readForeignFileNoFollow,
	type FileSeatStorageOptions,
} from "../../src/store/storage.ts";

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "seat-storage-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function cred(refresh: string): SeatCredential {
	return { type: "oauth", refresh, access: "at", expires: 1_900_000_000_000 };
}

function storeWithProfile(refresh: string): string {
	const store = emptyStore();
	store.providers.anthropic = {
		profiles: Object.assign(Object.create(null), { work: cred(refresh) }),
		aliases: Object.assign(Object.create(null)),
	};
	return encodeStore(store);
}

function backend(dir: string, options?: FileSeatStorageOptions): FileSeatStorageBackend {
	return new FileSeatStorageBackend(join(dir, "seat.json"), options);
}

describe("defaultSeatStorePath", () => {
	test("PI_CODING_AGENT_DIR wins; falls back to ~/.pi/agent", () => {
		expect(defaultSeatStorePath({ PI_CODING_AGENT_DIR: "/synthetic/dir" })).toBe("/synthetic/dir/seat.json");
		expect(defaultSeatStorePath({})).toEndWith("/.pi/agent/seat.json");
	});
});

describe("FileSeatStorageBackend (AC-002)", () => {
	test("first create writes the file with mode 0600", () => {
		withTempDir((dir) => {
			const storage = backend(dir);
			storage.withLock(() => ({ result: undefined, next: storeWithProfile("rt-1") }));
			const mode = statSync(join(dir, "seat.json")).mode & 0o777;
			expect(mode).toBe(0o600);
		});
	});

	test("read rejects a symlinked store path", () => {
		withTempDir((dir) => {
			const target = join(dir, "elsewhere.json");
			writeFileSync(target, storeWithProfile("rt-1"), { mode: 0o600 });
			symlinkSync(target, join(dir, "seat.json"));
			const storage = backend(dir);
			expect(() => storage.read((current) => current)).toThrow(/regular file/);
		});
	});

	test("withLock write rejects a symlinked store path (O_EXCL temp + read guard)", () => {
		withTempDir((dir) => {
			const target = join(dir, "elsewhere.json");
			writeFileSync(target, storeWithProfile("rt-old"), { mode: 0o600 });
			symlinkSync(target, join(dir, "seat.json"));
			const storage = backend(dir);
			expect(() => storage.withLock(() => ({ result: undefined, next: storeWithProfile("rt-new") }))).toThrow(
				/regular file/,
			);
			// The symlink target must not have been overwritten through the link.
			expect(readFileSync(target, "utf8")).toBe(storeWithProfile("rt-old"));
		});
	});

	test("atomic write: injected crash before rename leaves old content intact and no temp litter", () => {
		withTempDir((dir) => {
			const path = join(dir, "seat.json");
			const original = storeWithProfile("rt-old");
			new FileSeatStorageBackend(path).withLock(() => ({ result: undefined, next: original }));

			const crashing = backend(dir, {
				onBeforeRename: () => {
					throw new Error("simulated crash before rename");
				},
			});
			expect(() => crashing.withLock(() => ({ result: undefined, next: storeWithProfile("rt-new") }))).toThrow(
				/simulated crash/,
			);

			expect(readFileSync(path, "utf8")).toBe(original);
			const litter = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
			expect(litter).toEqual([]);
			expect(existsSync(`${path}.lock`)).toBe(false); // lock released despite the crash

			// Store still writable after the crash (fresh backend without the crash seam).
			const recovered = backend(dir);
			recovered.withLock(() => ({ result: undefined, next: storeWithProfile("rt-recovered") }));
			expect(readFileSync(path, "utf8")).toBe(storeWithProfile("rt-recovered"));
		});
	});

	test("crash on very first create leaves no store file", () => {
		withTempDir((dir) => {
			const path = join(dir, "seat.json");
			const crashing = backend(dir, {
				onBeforeRename: () => {
					throw new Error("simulated crash before rename");
				},
			});
			expect(() => crashing.withLock(() => ({ result: undefined, next: storeWithProfile("rt-1") }))).toThrow();
			expect(existsSync(path)).toBe(false);
			expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		});
	});

	test("read of a missing store yields undefined → decodeStore gives an empty store", () => {
		withTempDir((dir) => {
			const storage = backend(dir);
			const store = storage.read((current) => decodeStore(current));
			expect(store).toEqual(emptyStore());
		});
	});

	test("withLock round-trip: mutator sees committed content on the next call", () => {
		withTempDir((dir) => {
			const storage = backend(dir);
			storage.withLock(() => ({ result: undefined, next: storeWithProfile("rt-1") }));
			const seen = storage.withLock((current) => ({ result: decodeStore(current) }));
			expect(seen.providers.anthropic?.profiles["work"]?.refresh).toBe("rt-1");
		});
	});

	test("withLockAsync commits and releases the lock", async () => {
		await (async () => {
			const dir = mkdtempSync(join(tmpdir(), "seat-storage-"));
			try {
				const path = join(dir, "seat.json");
				const storage = new FileSeatStorageBackend(path);
				const result = await storage.withLockAsync(async (current) => {
					expect(current).toBeUndefined();
					return { result: "done", next: storeWithProfile("rt-async") };
				});
				expect(result).toBe("done");
				expect(readFileSync(path, "utf8")).toBe(storeWithProfile("rt-async"));
				expect(existsSync(`${path}.lock`)).toBe(false);
				expect(statSync(path).mode & 0o777).toBe(0o600);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		})();
	});
});

describe("DEC-003: no commit after compromise (T033, T040 regressions)", () => {
	test("a writer resuming after stale takeover cannot overwrite the new writer's commit", () => {
		withTempDir((dir) => {
			const path = join(dir, "seat.json");
			new FileSeatStorageBackend(path).withLock(() => ({ result: undefined, next: storeWithProfile("rt-original") }));

			const slowWriter = backend(dir);
			expect(() =>
				slowWriter.withLock(() => {
					// Simulate the pause: the lock goes stale (stand-in: remove it,
					// like T007's utimes trick) and another process takes over,
					// rotates the credential, and releases.
					rmSync(`${path}.lock`, { recursive: true, force: true });
					new FileSeatStorageBackend(path).withLock(() => ({ result: undefined, next: storeWithProfile("rt-rotated") }));
					// The paused writer now resumes and tries to commit stale state.
					return { result: undefined, next: storeWithProfile("rt-stale-clobber") };
				}),
			).toThrow(/compromised/);

			// The takeover's rotation survives; the stale commit never landed.
			expect(readFileSync(path, "utf8")).toBe(storeWithProfile("rt-rotated"));
		});
	});

	test("a takeover that is still holding the lock also blocks the resumed writer", () => {
		withTempDir((dir) => {
			const path = join(dir, "seat.json");
			new FileSeatStorageBackend(path).withLock(() => ({ result: undefined, next: storeWithProfile("rt-original") }));

			const slowWriter = backend(dir);
			expect(() =>
				slowWriter.withLock(() => {
					rmSync(`${path}.lock`, { recursive: true, force: true });
					mkdirSync(`${path}.lock`); // another process's fresh lock, still held
					return { result: undefined, next: storeWithProfile("rt-stale-clobber") };
				}),
			).toThrow(/compromised/);
			expect(readFileSync(path, "utf8")).toBe(storeWithProfile("rt-original"));
			// T041: releasing here would rmdir the SUCCESSOR's lock (proper-lockfile
			// removes by path, never by ownership), opening the store to a third
			// writer while the successor is mid-commit.
			expect(existsSync(`${path}.lock`)).toBe(true);
		});
	});

	test("T041 regression: withLockAsync also leaves the successor's lock alone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "seat-storage-"));
		try {
			const path = join(dir, "seat.json");
			new FileSeatStorageBackend(path).withLock(() => ({ result: undefined, next: storeWithProfile("rt-original") }));

			const slowWriter = new FileSeatStorageBackend(path);
			await expect(
				slowWriter.withLockAsync(async () => {
					rmSync(`${path}.lock`, { recursive: true, force: true });
					mkdirSync(`${path}.lock`);
					return { result: undefined, next: storeWithProfile("rt-stale-clobber") };
				}),
			).rejects.toThrow(/compromised/);
			expect(readFileSync(path, "utf8")).toBe(storeWithProfile("rt-original"));
			expect(existsSync(`${path}.lock`)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("T041 regression: the successor's lock survives the refusing process exiting", async () => {
		const dir = mkdtempSync(join(tmpdir(), "seat-storage-"));
		try {
			const path = join(dir, "seat.json");
			new FileSeatStorageBackend(path).withLock(() => ({ result: undefined, next: storeWithProfile("rt-original") }));

			// proper-lockfile also rmdirs every still-registered lock on process
			// exit, so skipping the release is not enough on its own: a CLI that
			// refuses a commit and exits milliseconds later would still delete the
			// successor's lock.
			const worker = new URL("./lock-abandon-worker.ts", import.meta.url).pathname;
			const proc = Bun.spawn(["bun", worker, path], { stdout: "pipe", stderr: "pipe" });
			const code = await proc.exited;
			if (code !== 0) throw new Error(`worker exited ${code}: ${await new Response(proc.stderr).text()}`);

			expect(existsSync(`${path}.lock`)).toBe(true);
			expect(readFileSync(path, "utf8")).toBe(storeWithProfile("rt-original"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("T040 regression: a takeover landing between the check and the rename cannot be clobbered", () => {
		withTempDir((dir) => {
			const path = join(dir, "seat.json");
			new FileSeatStorageBackend(path).withLock(() => ({ result: undefined, next: storeWithProfile("rt-original") }));

			// The pause is injected where the real one lives: temp file written,
			// rename — the actual publication — not yet issued.
			const slowWriter = backend(dir, {
				onBeforeRename: () => {
					rmSync(`${path}.lock`, { recursive: true, force: true });
					new FileSeatStorageBackend(path).withLock(() => ({
						result: undefined,
						next: storeWithProfile("rt-rotated"),
					}));
				},
			});

			expect(() =>
				slowWriter.withLock(() => ({ result: undefined, next: storeWithProfile("rt-stale-clobber") })),
			).toThrow(/compromised/);

			expect(readFileSync(path, "utf8")).toBe(storeWithProfile("rt-rotated"));
			expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		});
	});

	test("T040 regression: withLockAsync fences the rename too", async () => {
		const dir = mkdtempSync(join(tmpdir(), "seat-storage-"));
		try {
			const path = join(dir, "seat.json");
			new FileSeatStorageBackend(path).withLock(() => ({ result: undefined, next: storeWithProfile("rt-original") }));

			const slowWriter = new FileSeatStorageBackend(path, {
				onBeforeRename: () => {
					rmSync(`${path}.lock`, { recursive: true, force: true });
					new FileSeatStorageBackend(path).withLock(() => ({
						result: undefined,
						next: storeWithProfile("rt-rotated"),
					}));
				},
			});

			await expect(
				slowWriter.withLockAsync(async () => ({ result: undefined, next: storeWithProfile("rt-stale-clobber") })),
			).rejects.toThrow(/compromised/);

			expect(readFileSync(path, "utf8")).toBe(storeWithProfile("rt-rotated"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("read-only mutations never trip the ownership check", () => {
		withTempDir((dir) => {
			const storage = backend(dir);
			storage.withLock(() => ({ result: undefined, next: storeWithProfile("rt-1") }));
			const seen = storage.withLock((current) => ({ result: current }));
			expect(seen).toContain("rt-1");
		});
	});
});

describe("readForeignFileNoFollow", () => {
	test("reads regular files, refuses symlinks, never chmods", () => {
		withTempDir((dir) => {
			const file = join(dir, "auth.json");
			writeFileSync(file, `{"x":1}`, { mode: 0o644 });
			expect(readForeignFileNoFollow(file)).toBe(`{"x":1}`);
			expect(statSync(file).mode & 0o777).toBe(0o644); // untouched metadata

			const link = join(dir, "link.json");
			symlinkSync(file, link);
			expect(() => readForeignFileNoFollow(link)).toThrow(/regular file/);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);

			expect(readForeignFileNoFollow(join(dir, "missing.json"))).toBeUndefined();
		});
	});
});
