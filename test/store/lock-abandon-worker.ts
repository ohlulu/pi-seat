/**
 * Abandoned-lock worker (T041). Spawned by storage.test.ts.
 * Usage: bun lock-abandon-worker.ts <storePath>
 *
 * Takes the lock, simulates a stale takeover (its own lock replaced by a fresh
 * one another process is still holding), then tries to commit. The commit must
 * be refused, and the successor's lock must outlive this process — both
 * proper-lockfile's release and its exit handler rmdir by path with no
 * ownership check, so exiting is its own way of deleting someone else's lock.
 *
 * Exit 0 = commit refused as expected; the parent asserts the lock survived.
 */
import { mkdirSync, rmSync } from "node:fs";
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";
import { FileSeatStorageBackend, encodeStore } from "../../src/store/storage.ts";

const [storePath] = process.argv.slice(2);
if (!storePath) {
	console.error("usage: bun lock-abandon-worker.ts <storePath>");
	process.exit(2);
}

function clobberContent(): string {
	const credential: SeatCredential = {
		type: "oauth",
		refresh: "rt-stale-clobber",
		access: "at-stale-clobber",
		expires: 1_900_000_000_000,
	};
	const store = emptyStore();
	store.providers.anthropic = {
		profiles: Object.assign(Object.create(null), { work: credential }),
		aliases: Object.assign(Object.create(null)),
	};
	return encodeStore(store);
}

let refused = false;
try {
	new FileSeatStorageBackend(storePath).withLock(() => {
		rmSync(`${storePath}.lock`, { recursive: true, force: true });
		mkdirSync(`${storePath}.lock`); // successor's lock, still held
		return { result: undefined, next: clobberContent() };
	});
} catch (error) {
	refused = /compromised/.test(error instanceof Error ? error.message : String(error));
}

if (!refused) console.error("commit was not refused");
process.exit(refused ? 0 : 1);
