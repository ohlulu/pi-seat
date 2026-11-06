/**
 * Banked usage-limit resets (REQ-012, DEC-014): find the reset an account
 * would use, and redeem it.
 *
 * Both providers expose the same idea through different wire shapes:
 *
 * - Codex: `GET wham/rate-limit-reset-credits` lists credits; `POST
 *   …/consume` redeems one by id. Contract from openai/codex
 *   `backend-client/src/client/rate_limit_resets.rs`.
 * - Anthropic: the `cedar_ember` block of `/api/oauth/usage?cedar_ember=1`
 *   lists grants and names the one to use next; `POST
 *   /api/organizations/{org}/reset_rate_limits` redeems it. Contract read from
 *   Claude Code 2.1.280's `/limit-reset` command — undocumented, so every field
 *   is parsed defensively.
 *
 * Redeeming is irreversible. Nothing here retries a redeem: each attempt
 * carries a fresh idempotency key, so a retry after a lost response is a new
 * request, not a replay. A failure says how to check instead.
 */

import type { ProviderId, SeatCredential } from "../store/schema.ts";
import type { RefreshCallback } from "../store/refresh.ts";
import { isExpired } from "../store/refresh.ts";
import type { SeatStorageBackend } from "../store/storage.ts";
import type { StoreSchedule } from "../store/scheduler.ts";
import { redactTokenText } from "../store/redact.ts";
import {
	CLAUDE_API_BASE,
	CODEX_API_BASE,
	USAGE_TIMEOUT_MS,
	claudeHeaders,
	codexHeaders,
	fetchClaudeUsage,
	prepareProfile,
	readBuiltinSnapshot,
	type UsageFetchOptions,
} from "./fetch.ts";
import { parseResetDate, type ClaudeResetGrant } from "./render.ts";

export const CODEX_RESET_CREDITS_URL = `${CODEX_API_BASE}/wham/rate-limit-reset-credits`;
export const CODEX_RESET_CONSUME_URL = `${CODEX_RESET_CREDITS_URL}/consume`;
export const CLAUDE_PROFILE_URL = `${CLAUDE_API_BASE}/api/oauth/profile`;
export const CLAUDE_RESET_PROGRAM = "cedar_ember";
/** A redeem is one server-side transaction; Claude Code allows it 25s. */
export const RESET_TIMEOUT_MS = 25_000;

/** Claude Code refuses to send ids outside these shapes; so does seat. */
const CLAUDE_GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const ORGANIZATION_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Window names as the meters print them. */
const WINDOW_LABELS: Record<string, string> = { five_hour: "5h", seven_day: "weekly" };

export interface ResetOffer {
	provider: ProviderId;
	/** Codex credit id or Anthropic grant id — exactly what the redeem sends. */
	id: string;
	title: string;
	expiresAt: Date | null;
	/** Resets left on this account, this one included. */
	remaining: number;
	/** Windows the reset refills, in meter names; empty when the provider does not say. */
	refills: string[];
	/** Why the server may refuse; a refusal uses nothing. */
	caveat?: string;
}

export type ResetLookup = { kind: "offer"; offer: ResetOffer } | { kind: "none"; message: string };

export interface ResetOutcome {
	/** The reset was consumed and limits changed: the meters are stale. */
	used: boolean;
	message: string;
}

export interface ResetRequestOptions extends UsageFetchOptions {
	/** Idempotency key source; random per attempt in production. */
	requestId?: () => string;
}

// --- credential ---------------------------------------------------------------

export interface ResetCredentialDeps {
	backend: SeatStorageBackend;
	authPath: string;
	refreshFor: (provider: ProviderId) => RefreshCallback;
	schedule: StoreSchedule;
	fetchOptions?: UsageFetchOptions;
}

export type ResetCredential = { ok: true; credential: SeatCredential; secrets: string[] } | { ok: false; message: string };

/**
 * The credential a reset for this account rides on.
 *
 * A stored profile is refreshed through the REQ-005 locked path, as one store
 * task (DEC-013). The built-in login is Pi's grant: read from the auth.json
 * snapshot and NEVER refreshed (DEC-005) — expired means the user runs Pi
 * once, exactly as the meters already say.
 */
export async function resetCredential(
	deps: ResetCredentialDeps,
	account: { provider: ProviderId; kind: "profile" | "builtin"; label?: string },
): Promise<ResetCredential> {
	if (account.kind === "profile") {
		const label = account.label;
		if (label === undefined) return { ok: false, message: "no stored profile to use" };
		const result = await deps.schedule(() =>
			prepareProfile(deps.backend, account.provider, label, deps.refreshFor(account.provider), deps.fetchOptions ?? {}),
		);
		return result.ok
			? { ok: true, credential: result.prepared.credential, secrets: result.prepared.secrets }
			: { ok: false, message: result.error };
	}
	const credential = readBuiltinSnapshot(deps.authPath, account.provider);
	if (credential === undefined) return { ok: false, message: "Pi has no login for this provider" };
	const now = deps.fetchOptions?.now ?? Date.now;
	if (typeof credential.expires === "number" && isExpired(credential, now(), 0)) {
		return { ok: false, message: "Pi's token expired — run pi once to refresh it; seat never touches Pi's grant" };
	}
	return { ok: true, credential, secrets: [credential.access, credential.refresh] };
}

// --- lookup -------------------------------------------------------------------

/** The reset this account would redeem next, or why there is none. */
export async function findResetOffer(
	provider: ProviderId,
	credential: SeatCredential,
	options: UsageFetchOptions = {},
): Promise<ResetLookup> {
	return provider === "anthropic" ? findClaudeOffer(credential, options) : findCodexOffer(credential, options);
}

interface CodexCredit {
	id?: unknown;
	status?: unknown;
	expires_at?: unknown;
	title?: unknown;
}

async function findCodexOffer(credential: SeatCredential, options: UsageFetchOptions): Promise<ResetLookup> {
	const body = (await request("GET", CODEX_RESET_CREDITS_URL, codexHeaders(credential), undefined, options)).json;
	const record = asRecord(body);
	const credits = (Array.isArray(record?.["credits"]) ? (record["credits"] as CodexCredit[]) : [])
		.filter((credit) => credit?.status === "available" && typeof credit.id === "string" && credit.id.length > 0)
		.map((credit) => ({
			id: credit.id as string,
			title: typeof credit.title === "string" && credit.title.length > 0 ? credit.title : "Usage limit reset",
			expiresAt: typeof credit.expires_at === "string" ? parseResetDate(credit.expires_at) : null,
		}))
		// The one closest to expiring goes first: using a later one would let this lapse.
		.sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity));
	const next = credits[0];
	if (next === undefined) return { kind: "none", message: "no usage limit resets available" };
	const count = record?.["available_count"];
	return {
		kind: "offer",
		offer: {
			provider: "openai-codex",
			...next,
			remaining: typeof count === "number" && Number.isInteger(count) && count >= credits.length ? count : credits.length,
			refills: [],
			caveat: "used only if it refills at least one window",
		},
	};
}

const CLAUDE_INELIGIBLE: Record<string, string> = {
	no_grant: "no limit resets available",
	surface: "Anthropic does not offer resets to this client",
	cli_version: "seat's Claude Code identity is too old for resets — update pi-seat",
	paused: "your reset is paused",
	expired: "your reset expired",
};

async function findClaudeOffer(credential: SeatCredential, options: UsageFetchOptions): Promise<ResetLookup> {
	const status = (await fetchClaudeUsage(credential.access, options)).cedar_ember;
	if (status === undefined || status === null) return { kind: "none", message: "no limit-reset program on this account" };
	const grants = Array.isArray(status.grants) ? status.grants : [];
	// The server only redeems the grant it names next (`not_next_grant` otherwise).
	const grant = grants.find((g): g is ClaudeResetGrant & { id: string } => typeof g?.id === "string" && g.id === status.next_grant_id);
	if (grant === undefined || !CLAUDE_GRANT_ID.test(grant.id)) {
		const reason = status.ineligible_reason ?? "no_grant";
		return { kind: "none", message: CLAUDE_INELIGIBLE[reason] ?? `no limit reset available (${reason})` };
	}
	if (grant.paused === true) return { kind: "none", message: CLAUDE_INELIGIBLE["paused"]! };
	const atLimit = status.at_limit === true;
	let caveat: string | undefined;
	if (grant.use_requires_limit !== false && !atLimit) caveat = "works only at a usage limit, and you are not at one";
	else if (!atLimit) caveat = "you have not reached a limit yet";
	const cooldown = parseResetDate(status.cooldown_until ?? null);
	if (cooldown !== null && cooldown.getTime() > (options.now ?? Date.now)()) caveat = "another reset is still going through";
	const left = grant.resets_left;
	return {
		kind: "offer",
		offer: {
			provider: "anthropic",
			id: grant.id,
			title: typeof grant.label === "string" && grant.label.length > 0 ? grant.label : "Limit reset",
			expiresAt: parseResetDate(grant.ends_at ?? null),
			remaining: typeof left === "number" && Number.isInteger(left) && left > 0 ? left : 1,
			refills: (Array.isArray(grant.clears) ? grant.clears : []).map((window) => WINDOW_LABELS[window] ?? window),
			...(caveat !== undefined ? { caveat } : {}),
		},
	};
}

// --- redeem -------------------------------------------------------------------

/** Spend `offer`. Never throws: every failure is an outcome that names what to do. */
export async function redeemReset(
	credential: SeatCredential,
	offer: ResetOffer,
	secrets: readonly string[],
	options: ResetRequestOptions = {},
): Promise<ResetOutcome> {
	const requestId = (options.requestId ?? (() => crypto.randomUUID()))();
	try {
		return offer.provider === "anthropic"
			? await redeemClaude(credential, offer, requestId, options)
			: await redeemCodex(credential, offer, requestId, options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			used: false,
			message: `reset not confirmed: ${redactTokenText(message, [...secrets])} — press r to check whether it went through`,
		};
	}
}

const CODEX_OUTCOMES: Record<string, string> = {
	nothing_to_reset: "nothing to reset right now · reset kept",
	no_credit: "no usage limit resets available",
	already_redeemed: "that reset was already used",
};

async function redeemCodex(
	credential: SeatCredential,
	offer: ResetOffer,
	requestId: string,
	options: ResetRequestOptions,
): Promise<ResetOutcome> {
	const response = await request(
		"POST",
		CODEX_RESET_CONSUME_URL,
		codexHeaders(credential),
		{ redeem_request_id: requestId, credit_id: offer.id },
		options,
		{ timeoutMs: RESET_TIMEOUT_MS, statusOutcomes: true },
	);
	const refused = refusedByStatus(response);
	if (refused !== undefined) return refused;
	const code = asRecord(response.json)?.["code"];
	if (code === "reset") {
		const windows = asRecord(response.json)?.["windows_reset"];
		const refilled = typeof windows === "number" && windows > 0 ? ` · ${windows} window${windows === 1 ? "" : "s"} refilled` : "";
		return { used: true, message: `reset used${refilled}` };
	}
	if (typeof code === "string" && CODEX_OUTCOMES[code] !== undefined) return { used: false, message: CODEX_OUTCOMES[code] };
	throw new Error("unreadable response");
}

const CLAUDE_OUTCOMES: Record<string, string> = {
	already_used: "that reset was already used · nothing changed",
	not_limited: "not at a usage limit · reset kept",
	cooldown: "another reset just went through · try again in a minute",
	unavailable: "reset unavailable right now · nothing was used",
};

async function redeemClaude(
	credential: SeatCredential,
	offer: ResetOffer,
	requestId: string,
	options: ResetRequestOptions,
): Promise<ResetOutcome> {
	if (!CLAUDE_GRANT_ID.test(offer.id)) throw new Error("malformed grant id");
	const headers = claudeHeaders(credential.access);
	const profile = await request("GET", CLAUDE_PROFILE_URL, headers, undefined, options);
	const organization = asRecord(asRecord(profile.json)?.["organization"])?.["uuid"];
	if (typeof organization !== "string" || !ORGANIZATION_ID.test(organization)) throw new Error("no organization on this login");
	const response = await request(
		"POST",
		`${CLAUDE_API_BASE}/api/organizations/${organization}/reset_rate_limits`,
		headers,
		{ program: CLAUDE_RESET_PROGRAM, grant_id: offer.id, request_id: requestId },
		options,
		{ timeoutMs: RESET_TIMEOUT_MS, statusOutcomes: true },
	);
	const refused = refusedByStatus(response);
	if (refused !== undefined) return refused;
	const body = asRecord(response.json);
	const result = body?.["result"];
	if (result === "reset") {
		const cleared = Array.isArray(body?.["cleared"]) ? (body["cleared"] as unknown[]).filter((w): w is string => typeof w === "string") : [];
		const left = body?.["resets_left"];
		const refilled = cleared.length > 0 ? ` · ${cleared.map((w) => WINDOW_LABELS[w] ?? w).join(", ")} refilled` : "";
		const remaining = typeof left === "number" ? ` · ${left} left` : "";
		return { used: true, message: `reset used${refilled}${remaining}` };
	}
	if (result === "ineligible") {
		const reason = typeof body?.["reason"] === "string" ? ` (${body["reason"]})` : "";
		return { used: false, message: `not eligible${reason} · nothing was used` };
	}
	if (typeof result === "string" && CLAUDE_OUTCOMES[result] !== undefined) return { used: false, message: CLAUDE_OUTCOMES[result] };
	throw new Error("unreadable response");
}

/**
 * Statuses that prove the redeem was refused before it ran. Anything else
 * non-2xx is ambiguous — a 5xx may have committed — and throws, so the
 * caller says "not confirmed" instead of "nothing was used".
 */
function refusedByStatus(response: JsonResponse): ResetOutcome | undefined {
	if (response.status === 429) return { used: false, message: "rate limited · nothing was used · try again in a moment" };
	if (response.status === 401 || response.status === 403) {
		return { used: false, message: "this login cannot use resets · nothing was used · log in again, then retry" };
	}
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return undefined;
}

// --- transport ------------------------------------------------------------------

interface JsonResponse {
	ok: boolean;
	status: number;
	json: unknown;
}

async function request(
	method: "GET" | "POST",
	url: string,
	headers: Record<string, string>,
	body: unknown,
	options: UsageFetchOptions,
	extra: { timeoutMs?: number; statusOutcomes?: boolean } = {},
): Promise<JsonResponse> {
	const impl = options.fetchImpl ?? fetch;
	const response = await impl(url, {
		method,
		headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(extra.timeoutMs ?? options.timeoutMs ?? USAGE_TIMEOUT_MS),
	});
	if (!response.ok && extra.statusOutcomes !== true) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	let json: unknown;
	try {
		json = await response.json();
	} catch {
		json = undefined;
	}
	return { ok: response.ok, status: response.status, json };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
