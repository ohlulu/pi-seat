/**
 * Per-turn runtime auth coordinator (REQ-004, REQ-009) — adapted from
 * pi-accounts runtime-auth.ts (MIT, Copyright (c) 2026 narumiruna; see NOTICE),
 * restructured for seat's abort-first per-turn contract:
 *
 * Every turn, per provider: selection → locked refresh → toAuth → overlay →
 * verify. IF any step fails — sentinel installation included — the turn is
 * aborted FIRST, then a non-secret sentinel key is installed best-effort.
 * Abort never depends on the sentinel succeeding.
 *
 * Fail-closed state lives in memory only: transient failures retry next turn;
 * an invalid_grant blocks the provider until a replacement login rotates the
 * stored credential. Other providers are unaffected.
 *
 * Runtime access is pinned (plan.md, T015): a structural cast of
 * `ctx.modelRegistry.runtime` yields the active ModelRuntime; we feature-detect
 * setRuntimeApiKey/removeRuntimeApiKey and never construct a separate runtime.
 * Verified against Pi 0.84.2; missing methods mean an incompatible Pi and the
 * extension fails closed at startup (T019).
 */

// Pi's jiti extension loader aliases the bare "@earendil-works/pi-ai"
// specifier to a single entry file, so subpath imports break under `pi -e`.
// cleanupSessionResources (root export) dispatches to the registered
// closeOpenAICodexWebSocketSessions cleanup — same close, loadable path.
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { PROVIDER_IDS, type ProviderId, type SeatCredential } from "../store/schema.ts";
import { InvalidGrantError, ensureFreshProfile } from "../store/refresh.ts";
import { decodeStore, type SeatStorageBackend } from "../store/storage.ts";
import { resolveSelection } from "../store/selector.ts";
import { adapterFor, toRefreshCallback, type SeatProviderAdapter } from "./oauth.ts";

/** Non-secret sentinel installed after an abort; never a working credential. */
export const SEAT_SENTINEL_API_KEY = "pi-seat-auth-failed";

/** The slice of Pi's internal ModelRuntime that seat relies on. */
export interface SeatRuntime {
	setRuntimeApiKey(provider: string, apiKey: string): void | Promise<void>;
	removeRuntimeApiKey(provider: string): void | Promise<void>;
	/** Optional read-back used by the verify step when the Pi version exposes it. */
	getApiKeyForProvider?(provider: string): string | undefined | Promise<string | undefined>;
}

/**
 * Structural cast of ctx.modelRegistry.runtime (T015). Returns undefined when
 * this Pi version does not expose the runtime overlay — callers fail closed.
 */
export function getSeatRuntime(modelRegistry: unknown): SeatRuntime | undefined {
	if (!modelRegistry || typeof modelRegistry !== "object") return undefined;
	const runtime = (modelRegistry as { runtime?: unknown }).runtime;
	if (!runtime || typeof runtime !== "object") return undefined;
	const candidate = runtime as Record<string, unknown>;
	if (typeof candidate["setRuntimeApiKey"] !== "function") return undefined;
	if (typeof candidate["removeRuntimeApiKey"] !== "function") return undefined;
	return runtime as SeatRuntime;
}

export type TurnAuthResult =
	| { provider: ProviderId; status: "builtin" }
	| { provider: ProviderId; status: "applied"; label: string }
	| { provider: ProviderId; status: "aborted"; reason: string };

export interface CoordinatorOptions {
	runtime: SeatRuntime;
	backend: SeatStorageBackend;
	adapters: SeatProviderAdapter[];
	/** Init-time resolved PI_SEAT pins (DEC-002); immutable for the session. */
	pins: Partial<Record<ProviderId, string>>;
	/** Codex WebSocket invalidation seam (REQ-009); default is Pi's real close. */
	invalidateCodex?: (sessionId?: string) => void;
	sessionId?: string;
	now?: () => number;
	refreshTimeoutMs?: number;
}

interface BlockedState {
	label: string;
	/** Refresh token of the credential that died; a rotated one clears the block. */
	refresh: string;
	reason: string;
}

/** Effective identity for connection-invalidation purposes. */
type Identity = { kind: "label"; label: string } | { kind: "builtin" };

export class SeatRuntimeAuthCoordinator {
	private readonly blocked: Partial<Record<ProviderId, BlockedState>> = {};
	private readonly appliedIdentity: Partial<Record<ProviderId, Identity>> = {};
	private readonly overlayActive: Partial<Record<ProviderId, boolean>> = {};

	constructor(private readonly options: CoordinatorOptions) {}

	/**
	 * turn_start entry point: synchronize both providers. Each provider is
	 * isolated — an abort on one never touches the other's overlay.
	 */
	async syncTurn(abort: (reason: string) => void): Promise<TurnAuthResult[]> {
		const results: TurnAuthResult[] = [];
		for (const provider of PROVIDER_IDS) {
			results.push(await this.syncProvider(provider, abort));
		}
		return results;
	}

	async syncProvider(provider: ProviderId, abort: (reason: string) => void): Promise<TurnAuthResult> {
		let credentialForRedaction: SeatCredential | undefined;
		try {
			const store = this.options.backend.read((current) => decodeStore(current));
			const selection = resolveSelection(store, provider, this.options.pins[provider]);

			if (selection.source === "builtin") {
				// AC-006: with no pin and no default, Pi's built-in login runs
				// untouched — zero runtime override. Only remove what we own.
				if (this.overlayActive[provider]) {
					await this.invalidateOnIdentityChange(provider, { kind: "builtin" });
					await this.options.runtime.removeRuntimeApiKey(provider);
					this.overlayActive[provider] = false;
				}
				this.appliedIdentity[provider] = { kind: "builtin" };
				return { provider, status: "builtin" };
			}

			const label = selection.label;

			// Persistent fail-closed: a dead grant blocks this provider until a
			// replacement login rotates the stored refresh token (AC-007).
			const block = this.blocked[provider];
			if (block && block.label === label) {
				const currentRefresh = Object.hasOwn(store.providers[provider]?.profiles ?? {}, label)
					? store.providers[provider]?.profiles[label]?.refresh
					: undefined;
				if (currentRefresh === block.refresh) {
					return this.failClosed(provider, abort, new Error(block.reason));
				}
				delete this.blocked[provider]; // replacement login cleared it
			}

			const adapter = adapterFor(this.options.adapters, provider);
			// The stored credential's secrets must be redactable even when the
			// failure happens inside refresh, before a rotated credential exists.
			credentialForRedaction = store.providers[provider]?.profiles[label];
			let credential: SeatCredential;
			try {
				const nowOption = this.options.now;
				const outcome = await ensureFreshProfile(this.options.backend, provider, label, toRefreshCallback(adapter), {
					...(this.options.refreshTimeoutMs !== undefined ? { timeoutMs: this.options.refreshTimeoutMs } : {}),
					...(nowOption !== undefined ? { now: nowOption } : {}),
				});
				credential = outcome.credential;
				credentialForRedaction = credential;
			} catch (error) {
				if (error instanceof InvalidGrantError) {
					// Bind the block to the credential the refresh ACTUALLY sent
					// (locked re-read), not this coordinator's entry read — they
					// diverge under concurrent same-label replacement (T034).
					const deadRefresh = error.sentRefresh ?? store.providers[provider]?.profiles[label]?.refresh;
					if (deadRefresh !== undefined) {
						this.blocked[provider] = { label, refresh: deadRefresh, reason: error.message };
					}
					if (error.sentAccess !== undefined && error.sentRefresh !== undefined) {
						credentialForRedaction = {
							type: "oauth",
							refresh: error.sentRefresh,
							access: error.sentAccess,
							expires: 0,
						};
					}
				}
				throw error;
			}

			const auth = await adapter.oauth.toAuth(credential);
			validateModelAuth(auth, adapter.displayName);

			// REQ-009: close live Codex sockets BEFORE the new credential is
			// applied and the switch is reported — no request rides a stale grant.
			await this.invalidateOnIdentityChange(provider, { kind: "label", label });

			await this.options.runtime.setRuntimeApiKey(provider, auth.apiKey);
			this.overlayActive[provider] = true;
			await this.verifyApplied(provider, auth.apiKey);

			this.appliedIdentity[provider] = { kind: "label", label };
			return { provider, status: "applied", label };
		} catch (error) {
			return this.failClosed(provider, abort, error, credentialForRedaction);
		}
	}

	/** Abort FIRST, then best-effort sentinel. Sentinel failure changes nothing. */
	private failClosed(
		provider: ProviderId,
		abort: (reason: string) => void,
		error: unknown,
		credential?: SeatCredential,
	): TurnAuthResult {
		const reason = credential
			? redactTokenText(errorMessage(error), [credential.access, credential.refresh])
			: redactTokenText(errorMessage(error));
		abort(`seat: ${provider} auth failed — ${reason}`);
		try {
			const applied = this.options.runtime.setRuntimeApiKey(provider, SEAT_SENTINEL_API_KEY);
			if (applied instanceof Promise) applied.catch(() => undefined);
			this.overlayActive[provider] = true;
		} catch {
			// Best-effort only; the abort already protects the turn.
		}
		return { provider, status: "aborted", reason };
	}

	private async invalidateOnIdentityChange(provider: ProviderId, next: Identity): Promise<void> {
		if (provider !== "openai-codex") return;
		const previous = this.appliedIdentity[provider];
		if (previous !== undefined && identityEquals(previous, next)) return;
		if (previous === undefined && next.kind === "builtin") return;
		const invalidate = this.options.invalidateCodex ?? cleanupSessionResources;
		await invalidate(this.options.sessionId);
	}

	private async verifyApplied(provider: ProviderId, expected: string): Promise<void> {
		const readBack = this.options.runtime.getApiKeyForProvider;
		if (typeof readBack !== "function") return; // no read-back on this Pi version
		const actual = await readBack.call(this.options.runtime, provider);
		if (actual !== expected) {
			throw new Error(`Pi did not retain the runtime ${provider} credential`);
		}
	}
}

function identityEquals(left: Identity, right: Identity): boolean {
	if (left.kind === "builtin" || right.kind === "builtin") return left.kind === right.kind;
	return left.label === right.label;
}

/** Vendored from pi-accounts: validate provider-produced ModelAuth. */
export function validateModelAuth(
	auth: unknown,
	providerName: string,
): asserts auth is { apiKey: string; baseUrl?: string; headers?: Record<string, string | null> } {
	if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
		throw new Error(`${providerName} OAuth returned invalid request auth.`);
	}
	const record = auth as Record<string, unknown>;
	if (typeof record["apiKey"] !== "string" || !record["apiKey"]) {
		throw new Error(`${providerName} OAuth returned no API key.`);
	}
	const baseUrl = record["baseUrl"];
	if (baseUrl !== undefined) {
		if (typeof baseUrl !== "string") throw new Error(`${providerName} OAuth returned an invalid endpoint.`);
		let endpoint: URL;
		try {
			endpoint = new URL(baseUrl);
		} catch {
			throw new Error(`${providerName} OAuth returned an invalid endpoint.`);
		}
		if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
			throw new Error(`${providerName} OAuth returned an unsafe endpoint.`);
		}
	}
	const headers = record["headers"];
	if (headers !== undefined) {
		if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
			throw new Error(`${providerName} OAuth returned invalid headers.`);
		}
		for (const [name, value] of Object.entries(headers)) {
			if (!name || /[\r\n]/.test(name) || (value !== null && typeof value !== "string")) {
				throw new Error(`${providerName} OAuth returned invalid headers.`);
			}
			if (typeof value === "string" && /[\r\n]/.test(value)) {
				throw new Error(`${providerName} OAuth returned invalid headers.`);
			}
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Vendored from pi-accounts: strip token material from abort reasons. */
export function redactTokenText(text: string, exactSecrets: readonly string[] = []): string {
	const secrets = [...new Set(exactSecrets.filter(Boolean))].sort((a, b) => b.length - a.length);
	const exact = secrets.length
		? new RegExp(secrets.map((secret) => escapeRegExp(secret)).join("|"), "g")
		: undefined;
	return (exact ? text.replace(exact, "<redacted>") : text)
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
		.replace(/"(access|refresh|access_token|refresh_token|token)"\s*:\s*"[^"]+"/gi, '"$1":"<redacted>"')
		.replace(/\b(access|refresh)[_-][A-Za-z0-9._~+/=-]+/gi, "$1-<redacted>");
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
