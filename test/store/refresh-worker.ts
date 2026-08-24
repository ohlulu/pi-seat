/**
 * AC-009 worker (T009). Spawned by refresh-singleflight.test.ts.
 * Usage: bun refresh-worker.ts <storePath> <tokenUrl>
 *
 * Refreshes anthropic/work through the locked single-flight path, POSTing the
 * mock OAuth endpoint. Prints {refresh, refreshed} JSON on stdout.
 */
import { ensureFreshProfile, type RefreshCallback } from "../../src/store/refresh.ts";
import { FileSeatStorageBackend } from "../../src/store/storage.ts";
import type { SeatCredential } from "../../src/store/schema.ts";

const [storePath, tokenUrl] = process.argv.slice(2);
if (!storePath || !tokenUrl) {
	console.error("usage: bun refresh-worker.ts <storePath> <tokenUrl>");
	process.exit(2);
}

const refresh: RefreshCallback = async (credential: SeatCredential, signal: AbortSignal) => {
	const response = await fetch(tokenUrl, {
		method: "POST",
		body: JSON.stringify({ refresh_token: credential.refresh }),
		headers: { "content-type": "application/json" },
		signal,
	});
	if (!response.ok) throw new Error(`mock endpoint answered ${response.status}`);
	const body = (await response.json()) as { access: string; refresh: string; expires: number };
	return { type: "oauth", access: body.access, refresh: body.refresh, expires: body.expires };
};

const backend = new FileSeatStorageBackend(storePath);
const outcome = await ensureFreshProfile(backend, "anthropic", "work", refresh);
console.log(JSON.stringify({ refresh: outcome.credential.refresh, refreshed: outcome.refreshed }));
process.exit(0);
