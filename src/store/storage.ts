/**
 * Locked atomic storage for seat.json — adapted from pi-accounts storage.ts
 * (MIT, Copyright (c) 2026 narumiruna; see NOTICE).
 *
 * Lock protocol (plan.md DEC-003) — every process MUST use identical settings:
 * - `realpath: false` (default `realpath: true` ENOENTs when the target does
 *   not exist yet, so first-create would fail; Pi's own auth-storage does the same).
 * - Shared `stale` / `update` params and lock path across sync and async paths.
 * - Mutators re-check their condition on the content read inside the lock.
 * - After a lock is compromised, committing is forbidden — a write without the
 *   lock could clobber another process's rotated credential. The fence sits on
 *   the rename (the actual publication), not on the earlier temp-file write:
 *   a writer paused mid-write is exactly the writer a takeover races.
 * - Releasing is fenced the same way. proper-lockfile removes the lock
 *   directory by path, so after a takeover the release (and its exit handler)
 *   would delete the SUCCESSOR's lock and let a third writer in mid-commit.
 * - Temp file created 0600 with O_EXCL in dirname(seat.json); same-volume
 *   rename completes the atomic write.
 * - Reads open with O_NOFOLLOW and reject anything but a regular file.
 */

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdir,
	mkdirSync,
	openSync,
	readFileSync,
	realpath,
	realpathSync,
	renameSync,
	rmdir,
	rmdirSync,
	rmSync,
	stat,
	statSync,
	utimes,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { emptyStore, parseStore, serializeStore, type SeatStore } from "./schema.ts";

const PRIVATE_FILE_WRITE_OPTIONS = { encoding: "utf8", mode: 0o600 } as const;

/** DEC-003: one set of lock params for every caller, sync or async. */
export const LOCK_STALE_MS = 30_000;
export const LOCK_UPDATE_MS = 10_000;

const DEFAULT_SYNC_LOCK_TIMEOUT_MS = 5_000;
const SYNC_LOCK_RETRY_INTERVAL_MS = 20;
const syncSleepState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** seat.json location: $PI_CODING_AGENT_DIR/seat.json, else ~/.pi/agent/seat.json. */
export function defaultSeatStorePath(env: Record<string, string | undefined> = process.env): string {
	const agentDir = env["PI_CODING_AGENT_DIR"];
	if (agentDir !== undefined && agentDir.length > 0) return join(agentDir, "seat.json");
	return join(homedir(), ".pi", "agent", "seat.json");
}

type LockfileFsAdapter = {
	mkdir: typeof mkdir;
	mkdirSync: typeof mkdirSync;
	realpath: typeof realpath;
	realpathSync: typeof realpathSync;
	rmdir: typeof rmdir;
	rmdirSync: typeof rmdirSync;
	stat: typeof stat;
	statSync: typeof statSync;
	utimes: typeof utimes;
	utimesSync: typeof utimesSync;
};

// proper-lockfile caches mtime precision as a non-configurable symbol on this
// object. Keep it plain and stable instead of exposing Bun's loader-proxied
// filesystem module. (Upstream pi-accounts carries the same workaround.)
const LOCKFILE_FS_ADAPTER: LockfileFsAdapter = {
	mkdir,
	mkdirSync,
	realpath,
	realpathSync,
	rmdir,
	rmdirSync,
	stat,
	statSync,
	utimes,
	utimesSync,
};

// Used to drop proper-lockfile's bookkeeping for a lock we no longer own
// without removing the directory itself — unlockSync clears the update timer
// and the exit-handler registry, then rmdirs through this adapter.
const NON_REMOVING_LOCKFILE_FS: LockfileFsAdapter = {
	...LOCKFILE_FS_ADAPTER,
	rmdir: ((_path: unknown, callback: (error: Error | null) => void) => callback(null)) as unknown as typeof rmdir,
	rmdirSync: (() => undefined) as unknown as typeof rmdirSync,
};

export type StorageLockResult<T> = {
	result: T;
	/** When set, committed as the new file content before the lock is released. */
	next?: string;
};

export interface SeatStorageBackend {
	read<T>(reader: (current: string | undefined) => T): T;
	withLock<T>(mutator: (current: string | undefined) => StorageLockResult<T>): T;
	withLockAsync<T>(mutator: (current: string | undefined) => Promise<StorageLockResult<T>>): Promise<T>;
}

export interface FileSeatStorageOptions {
	syncLockTimeoutMs?: number;
	/** Test seam: injected between temp-file write and rename (crash simulation). */
	onBeforeRename?: () => void;
}

export class FileSeatStorageBackend implements SeatStorageBackend {
	constructor(
		readonly filePath: string,
		private readonly options: FileSeatStorageOptions = {},
	) {}

	read<T>(reader: (current: string | undefined) => T): T {
		if (!this.fileOrLockExistsForRead()) return reader(undefined);
		let release: (() => void) | undefined;
		let ownership: bigint | undefined;
		try {
			release = this.acquireLockSyncWithRetry();
			ownership = this.captureLockOwnership();
			return reader(readPrivateRegularFileIfExists(this.filePath));
		} finally {
			try {
				this.releaseOwnedLock(release, ownership);
			} catch {
				// A compromised lock may already belong to another process.
			}
		}
	}

	withLock<T>(mutator: (current: string | undefined) => StorageLockResult<T>): T {
		this.ensureParentDirectory();
		let release: (() => void) | undefined;
		let ownership: bigint | undefined;
		try {
			release = this.acquireLockSyncWithRetry();
			ownership = this.captureLockOwnership();
			const { result, next } = mutator(readPrivateRegularFileIfExists(this.filePath));
			// DEC-003: no commit after compromise. If this writer was paused long
			// enough for the lock to go stale and be taken over, the lock directory
			// was recreated (new inode) — publishing now would overwrite the other
			// process's rotated credential. writePrivate fences the rename itself.
			if (next !== undefined) this.writePrivate(next, ownership);
			return result;
		} finally {
			try {
				this.releaseOwnedLock(release, ownership);
			} catch {
				// A compromised lock may already belong to another process; the
				// ownership assertion above is the real guard — never let a release
				// failure mask it.
			}
		}
	}

	async withLockAsync<T>(mutator: (current: string | undefined) => Promise<StorageLockResult<T>>): Promise<T> {
		this.ensureParentDirectory();
		let release: (() => Promise<void>) | undefined;
		let ownership: bigint | undefined;
		let compromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (compromisedError) throw compromisedError;
		};

		try {
			release = await this.acquireLockAsync((error) => {
				compromisedError = error;
			});
			throwIfCompromised();
			ownership = this.captureLockOwnership();
			const { result, next } = await mutator(readPrivateRegularFileIfExists(this.filePath));
			// DEC-003: never commit after compromise — the lock no longer excludes
			// other writers, so this write could overwrite a rotated credential.
			// onCompromised is the async detector; the synchronous inode check
			// closes the window where the updater has not fired yet.
			throwIfCompromised();
			if (next !== undefined) this.writePrivate(next, ownership);
			throwIfCompromised();
			return result;
		} finally {
			try {
				await this.releaseOwnedLock(release, ownership);
			} catch {
				// A compromised lock may already have been removed by another process.
			}
		}
	}

	/**
	 * Release only what is still ours. After a stale takeover the lock directory
	 * belongs to the successor: removing it would let a third writer in while
	 * the successor is mid-commit (T041). In that case drop proper-lockfile's
	 * own bookkeeping instead — its exit handler rmdirs every lock still
	 * registered, so a refusing CLI process would otherwise delete the
	 * successor's lock on the way out.
	 */
	private releaseOwnedLock<R>(release: (() => R) | undefined, ownership: bigint | undefined): R | undefined {
		if (release === undefined) return undefined;
		if (this.stillOwnsLock(ownership)) return release();
		try {
			lockfile.unlockSync(this.filePath, { fs: NON_REMOVING_LOCKFILE_FS, realpath: false });
		} catch {
			// proper-lockfile's own compromise detector may have dropped it already.
		}
		return undefined;
	}

	/** Inode of our lock directory at acquisition; stale takeover recreates it. */
	private captureLockOwnership(): bigint | undefined {
		try {
			return statSync(`${this.filePath}.lock`, { bigint: true }).ino;
		} catch {
			return undefined;
		}
	}

	/** False whenever ownership cannot be PROVEN — unprovable means not ours. */
	private stillOwnsLock(acquiredIno: bigint | undefined): boolean {
		if (acquiredIno === undefined) return false;
		try {
			return statSync(`${this.filePath}.lock`, { bigint: true }).ino === acquiredIno;
		} catch {
			return false;
		}
	}

	private assertLockOwnership(acquiredIno: bigint | undefined): void {
		if (!this.stillOwnsLock(acquiredIno)) {
			throw new Error(`seat store lock compromised for ${this.filePath}; commit refused to protect the other writer's rotation`);
		}
	}

	private fileOrLockExistsForRead(): boolean {
		if (pathEntryExists(this.filePath)) return true;
		if (pathEntryExists(`${this.filePath}.lock`)) return true;
		// Close the publication race between checking the file and its lock.
		return pathEntryExists(this.filePath);
	}

	private ensureParentDirectory(): void {
		const parent = dirname(this.filePath);
		mkdirSync(parent, { recursive: true, mode: 0o700 });
	}

	private acquireLockAsync(onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
		return lockfile.lock(this.filePath, {
			fs: LOCKFILE_FS_ADAPTER,
			realpath: false,
			retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
			stale: LOCK_STALE_MS,
			update: LOCK_UPDATE_MS,
			onCompromised,
		});
	}

	private acquireLockSyncWithRetry(): () => void {
		const timeoutMs = this.options.syncLockTimeoutMs ?? DEFAULT_SYNC_LOCK_TIMEOUT_MS;
		const deadline = Date.now() + timeoutMs;
		while (true) {
			try {
				return lockfile.lockSync(this.filePath, {
					fs: LOCKFILE_FS_ADAPTER,
					realpath: false,
					stale: LOCK_STALE_MS,
					update: LOCK_UPDATE_MS,
				});
			} catch (error) {
				if (!isNodeError(error) || error.code !== "ELOCKED") throw error;
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) throw error;
				Atomics.wait(syncSleepState, 0, 0, Math.min(SYNC_LOCK_RETRY_INTERVAL_MS, remainingMs));
			}
		}
	}

	private writePrivate(contents: string, ownership: bigint | undefined): void {
		const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
		try {
			// "wx" = O_EXCL: refuse to follow a pre-planted symlink or reuse a
			// stale temp file. Same directory ⇒ same volume ⇒ atomic rename.
			writeFileSync(tempPath, contents, { ...PRIVATE_FILE_WRITE_OPTIONS, flag: "wx" });
			chmodSync(tempPath, 0o600);
			this.options.onBeforeRename?.();
			// The rename IS the commit, so the ownership fence belongs here — a
			// check before the temp write leaves the whole write window unfenced.
			this.assertLockOwnership(ownership);
			renameSync(tempPath, this.filePath);
			chmodSync(this.filePath, 0o600);
		} finally {
			rmSync(tempPath, { force: true });
		}
	}
}

function readPrivateRegularFileIfExists(filePath: string): string | undefined {
	return pathEntryExists(filePath) ? readPrivateRegularFile(filePath) : undefined;
}

function pathEntryExists(filePath: string): boolean {
	try {
		lstatSync(filePath);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

/** O_NOFOLLOW read of our own private file; self-heals permissions to 0600. */
function readPrivateRegularFile(filePath: string): string {
	const info = lstatSync(filePath);
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error(`seat store path must be a regular file: ${filePath}`);
	}
	let descriptor: number | undefined;
	try {
		descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		if (!fstatSync(descriptor).isFile()) {
			throw new Error(`seat store path must be a regular file: ${filePath}`);
		}
		fchmodSync(descriptor, 0o600);
		return readFileSync(descriptor, "utf8");
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/**
 * O_NOFOLLOW read of a foreign file (auth.json, claude-profiles.json).
 * Never chmods, never writes — read-only observation of files we do not own.
 */
export function readForeignFileNoFollow(filePath: string): string | undefined {
	if (!pathEntryExists(filePath)) return undefined;
	const info = lstatSync(filePath);
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error(`expected a regular file: ${filePath}`);
	}
	let descriptor: number | undefined;
	try {
		descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		if (!fstatSync(descriptor).isFile()) {
			throw new Error(`expected a regular file: ${filePath}`);
		}
		return readFileSync(descriptor, "utf8");
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

export class InMemorySeatStorageBackend implements SeatStorageBackend {
	private value: string | undefined;

	read<T>(reader: (current: string | undefined) => T): T {
		return reader(this.value);
	}

	withLock<T>(mutator: (current: string | undefined) => StorageLockResult<T>): T {
		const { result, next } = mutator(this.value);
		if (next !== undefined) this.value = next;
		return result;
	}

	async withLockAsync<T>(mutator: (current: string | undefined) => Promise<StorageLockResult<T>>): Promise<T> {
		const { result, next } = await mutator(this.value);
		if (next !== undefined) this.value = next;
		return result;
	}
}

/** Decode locked-read content into a SeatStore; absent file = empty store. */
export function decodeStore(current: string | undefined): SeatStore {
	if (current === undefined) return emptyStore();
	return parseStore(JSON.parse(current));
}

/** Encode a SeatStore for commit via StorageLockResult.next. */
export function encodeStore(store: SeatStore): string {
	return serializeStore(store);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
