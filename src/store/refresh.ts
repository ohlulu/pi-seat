/**
 * Locked single-flight token refresh (REQ-005).
 *
 * Every refresh — extension or CLI — goes through withLockAsync: acquire the
 * store lock, re-read, refresh only if the credential is STILL expired, write
 * the rotated credential back, release. The lock is held across the network
 * call on purpose: that is what makes concurrent refreshes of the same grant
 * single-flight across processes (AC-009).
 *
 * Lost-response semantics (plan.md Review Dispositions, amended P0):
 * - Timeout / network failure → transient. The store keeps the old credential;
 *   the next attempt re-sends the same refresh token.
 * - `invalid_grant` → persistent. The server has rotated (or revoked) the grant
 *   and we never received the new token; the grant is unrecoverable and the
 *   caller must fail closed until a replacement login. The stored credential is
 *   NOT deleted (AC-007).
 */

import type { ProviderId, SeatCredential } from "./schema.ts";
import { decodeStore, encodeStore, type SeatStorageBackend } from "./storage.ts";

/**
 * DI seam for all refresh tests and for the T014 OAuth adapters: exchange an
 * expired credential for a rotated one. Implementations MUST throw
 * InvalidGrantError when the server answers invalid_grant, and respect the
 * abort signal for timeout enforcement.
 */
export interface RefreshCallback {
	(credential: SeatCredential, signal: AbortSignal): Promise<SeatCredential>;
}

/** Persistent failure: the grant is dead; re-login is required. */
export class InvalidGrantError extends Error {
	override name = "InvalidGrantError";
	/**
	 * Identity of the credential the refresh ACTUALLY sent — the locked
	 * re-read's credential, which can differ from any unlocked read the caller
	 * did earlier. Fail-closed blocks must bind to this, or a concurrent
	 * same-label replacement unbinds the block and the dead token is re-sent.
	 */
	sentRefresh?: string;
	sentAccess?: string;
}

/** Transient failure: response lost (timeout/network); old credential kept. */
export class RefreshTimeoutError extends Error {
	override name = "RefreshTimeoutError";
}

export class ProfileNotFoundError extends Error {
	override name = "ProfileNotFoundError";
	constructor(provider: ProviderId, label: string) {
		super(`no profile "${label}" for provider "${provider}"`);
	}
}

/** Refresh when the token expires within this window, not only after expiry. */
export const EXPIRY_SKEW_MS = 60_000;

export function isExpired(credential: SeatCredential, nowMs: number, skewMs: number = EXPIRY_SKEW_MS): boolean {
	return credential.expires <= nowMs + skewMs;
}

export interface RefreshOptions {
	timeoutMs?: number;
	now?: () => number;
	skewMs?: number;
}

export interface RefreshOutcome {
	credential: SeatCredential;
	/** false when the locked re-read found a still-fresh credential (another process refreshed first). */
	refreshed: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Ensure the named profile holds a fresh credential, refreshing at most once
 * across all cooperating processes.
 */
export async function ensureFreshProfile(
	backend: SeatStorageBackend,
	provider: ProviderId,
	label: string,
	refresh: RefreshCallback,
	options: RefreshOptions = {},
): Promise<RefreshOutcome> {
	const now = options.now ?? Date.now;
	const skewMs = options.skewMs ?? EXPIRY_SKEW_MS;

	// Unlocked fast path: a fresh credential needs no lock at all.
	const fast = readProfile(backend, provider, label);
	if (!isExpired(fast, now(), skewMs)) return { credential: fast, refreshed: false };

	return backend.withLockAsync<RefreshOutcome>(async (current) => {
		// Locked re-check: another process may have rotated the credential
		// between our unlocked read and lock acquisition.
		const store = decodeStore(current);
		const section = store.providers[provider];
		const credential = section ? readOwn(section.profiles, label) : undefined;
		if (!section || !credential) throw new ProfileNotFoundError(provider, label);
		if (!isExpired(credential, now(), skewMs)) {
			return { result: { credential, refreshed: false } };
		}

		let rotated: SeatCredential;
		try {
			rotated = await callWithTimeout(refresh, credential, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		} catch (error) {
			if (error instanceof InvalidGrantError) {
				error.sentRefresh = credential.refresh;
				error.sentAccess = credential.access;
			}
			throw error;
		}
		section.profiles[label] = rotated;
		return { result: { credential: rotated, refreshed: true }, next: encodeStore(store) };
	});
}

function readProfile(backend: SeatStorageBackend, provider: ProviderId, label: string): SeatCredential {
	return backend.read((current) => {
		const store = decodeStore(current);
		const section = store.providers[provider];
		const credential = section ? readOwn(section.profiles, label) : undefined;
		if (!credential) throw new ProfileNotFoundError(provider, label);
		return credential;
	});
}

function readOwn<T>(map: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(map, key) ? map[key] : undefined;
}

async function callWithTimeout(
	refresh: RefreshCallback,
	credential: SeatCredential,
	timeoutMs: number,
): Promise<SeatCredential> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await refresh(credential, controller.signal);
	} catch (error) {
		// Once our timer fired, whatever rejection surfaced (the callback's own
		// abort error included) IS the lost-response case — classification must
		// not depend on which listener rejected first.
		if (controller.signal.aborted && !(error instanceof InvalidGrantError)) {
			throw new RefreshTimeoutError(`refresh timed out after ${timeoutMs}ms; response treated as lost`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
