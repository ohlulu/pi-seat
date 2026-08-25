/**
 * Usage endpoint clients (REQ-006) — same endpoints and headers as the Python
 * seat. Two hard rules from DEC-005:
 *
 * - A stored (seat-owned) profile MAY be refreshed on demand, and only through
 *   the REQ-005 locked single-flight path — a dormant profile's usage no
 *   longer goes missing because its access token expired.
 * - The auth.json built-in credential is Pi's grant: read-only snapshot, NEVER
 *   refreshed, never persisted into seat.json. Expired means "annotate", not
 *   "fix".
 */

import type { ProviderId, SeatCredential } from "../store/schema.ts";
import { ensureFreshProfile, isExpired, type RefreshCallback } from "../store/refresh.ts";
import { decodeStore, readForeignFileNoFollow, type SeatStorageBackend } from "../store/storage.ts";
import { redactTokenText } from "../store/redact.ts";
import type { ClaudeUsage, CodexUsage } from "./render.ts";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const USAGE_TIMEOUT_MS = 10_000;

export interface UsageFetchOptions {
	fetchImpl?: typeof fetch;
	claudeUrl?: string;
	codexUrl?: string;
	timeoutMs?: number;
	now?: () => number;
}

async function getJson(
	url: string,
	headers: Record<string, string>,
	options: UsageFetchOptions,
): Promise<unknown> {
	const impl = options.fetchImpl ?? fetch;
	const response = await impl(url, {
		headers,
		signal: AbortSignal.timeout(options.timeoutMs ?? USAGE_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	return response.json();
}

/** Claude oauth/usage with the Python seat's exact headers. */
export async function fetchClaudeUsage(access: string, options: UsageFetchOptions = {}): Promise<ClaudeUsage> {
	return (await getJson(
		options.claudeUrl ?? CLAUDE_USAGE_URL,
		{
			Authorization: `Bearer ${access}`,
			"anthropic-beta": "oauth-2025-04-20",
			Accept: "application/json",
			"User-Agent": "claude-code/2.1.69",
		},
		options,
	)) as ClaudeUsage;
}

/** Codex wham/usage with the Python seat's exact headers. */
export async function fetchCodexUsage(credential: SeatCredential, options: UsageFetchOptions = {}): Promise<CodexUsage> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credential.access}`,
		Accept: "application/json",
		"User-Agent": "seat",
	};
	const accountId = credential["accountId"];
	if (typeof accountId === "string" && accountId.length > 0) headers["ChatGPT-Account-Id"] = accountId;
	return (await getJson(options.codexUrl ?? CODEX_USAGE_URL, headers, options)) as CodexUsage;
}

export type ProfileUsageResult =
	| { ok: true; label: string; usage: ClaudeUsage | CodexUsage; refreshed: boolean }
	| { ok: false; label: string; error: string };

/**
 * Usage for one stored profile: locked refresh when expired (AC-010), then
 * the provider's usage endpoint. One account's failure is never fatal — the
 * caller renders the error inline.
 */
export async function profileUsage(
	backend: SeatStorageBackend,
	provider: ProviderId,
	label: string,
	refresh: RefreshCallback,
	options: UsageFetchOptions = {},
): Promise<ProfileUsageResult> {
	// Collected up front so even refresh-time failures redact the credential
	// that was involved (T037); rotated secrets are added as they appear.
	const secrets: string[] = [];
	try {
		const stored = backend.read((current) => decodeStore(current)).providers[provider]?.profiles[label];
		if (stored) secrets.push(stored.access, stored.refresh);
	} catch {
		// Store unreadable → pattern-based redaction still applies below.
	}
	try {
		const outcome = await ensureFreshProfile(backend, provider, label, refresh, {
			...(options.now !== undefined ? { now: options.now } : {}),
			// This read is unlocked, so a concurrent same-label replacement means
			// the refresh sends a credential we have never seen. Redaction has to
			// follow what was actually sent, not what we read (T042).
			onAttempt: (sent) => secrets.push(sent.access, sent.refresh),
		});
		secrets.push(outcome.credential.access, outcome.credential.refresh);
		const usage =
			provider === "anthropic"
				? await fetchClaudeUsage(outcome.credential.access, options)
				: await fetchCodexUsage(outcome.credential, options);
		return { ok: true, label, usage, refreshed: outcome.refreshed };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, label, error: redactTokenText(message, secrets) };
	}
}

export type BuiltinUsageResult =
	| { ok: true; usage: ClaudeUsage | CodexUsage }
	| { ok: false; error: string }
	| { expired: true }
	| undefined;

/** Read-only auth.json snapshot for one provider; undefined when absent. */
export function readBuiltinSnapshot(authPath: string, provider: ProviderId): SeatCredential | undefined {
	const content = readForeignFileNoFollow(authPath);
	if (content === undefined) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const entry = Object.hasOwn(raw, provider) ? (raw as Record<string, unknown>)[provider] : undefined;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const cred = entry as Record<string, unknown>;
	if (cred["type"] !== "oauth" || typeof cred["access"] !== "string") return undefined;
	return cred as unknown as SeatCredential;
}

/**
 * Usage for the built-in login credential. SHALL NOT refresh (DEC-005): an
 * expired snapshot is reported as such, and Pi refreshes its own grant on its
 * own schedule.
 */
export async function builtinUsage(
	authPath: string,
	provider: ProviderId,
	options: UsageFetchOptions = {},
): Promise<BuiltinUsageResult> {
	const credential = readBuiltinSnapshot(authPath, provider);
	if (credential === undefined) return undefined;
	const now = options.now ?? Date.now;
	if (typeof credential.expires === "number" && isExpired(credential, now(), 0)) {
		return { expired: true };
	}
	try {
		const usage =
			provider === "anthropic"
				? await fetchClaudeUsage(credential.access, options)
				: await fetchCodexUsage(credential, options);
		return { ok: true, usage };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
