/**
 * Cross-process lock contention worker (T007). Spawned by lock-crossproc.test.ts.
 * Usage: bun lock-worker.ts <storePath> <label> <holdMs>
 *
 * Inside the lock: read → hold → add a profile named <label> → commit.
 * If mutual exclusion is broken, two concurrent workers read the same base
 * content and one profile is lost.
 */
import { FileSeatStorageBackend, decodeStore, encodeStore } from "../../src/store/storage.ts";
import type { ProviderSection, SeatCredential } from "../../src/store/schema.ts";

const [storePath, label, holdMsRaw] = process.argv.slice(2);
if (!storePath || !label) {
	console.error("usage: bun lock-worker.ts <storePath> <label> <holdMs>");
	process.exit(2);
}
const holdMs = Number(holdMsRaw ?? "0");

const credential: SeatCredential = {
	type: "oauth",
	refresh: `rt-${label}`,
	access: `at-${label}`,
	expires: 1_900_000_000_000,
};

const backend = new FileSeatStorageBackend(storePath, { syncLockTimeoutMs: 15_000 });
backend.withLock((current) => {
	const store = decodeStore(current);
	let section: ProviderSection | undefined = store.providers.anthropic;
	if (!section) {
		section = {
			profiles: Object.create(null) as Record<string, SeatCredential>,
			aliases: Object.create(null) as Record<string, string>,
		};
		store.providers.anthropic = section;
	}
	if (holdMs > 0) Bun.sleepSync(holdMs);
	section.profiles[label] = credential;
	return { result: undefined, next: encodeStore(store) };
});
process.exit(0);
