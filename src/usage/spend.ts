/**
 * API-key spend transport (REQ-014, DEC-016). Pi-free, like fetch.ts and
 * resets.ts.
 *
 * Two Admin API calls, both authenticated with the profile's own Admin key:
 *
 * 1. `GET /v1/organizations/api_keys` maps the profile's key to its
 *    `api_key_id` through `partial_key_hint` (`<prefix>...<suffix>`). It runs on
 *    every lookup on purpose: a cached id would silently keep pointing at a key
 *    that was revoked and reissued.
 * 2. `GET /v1/organizations/analytics/cost` totals that id's cost since the
 *    cycle start. `amount` is cost before credits, in cents, as a decimal string.
 *
 * No message produced here contains either key.
 */

import { redactTokenText } from "../store/redact.ts";

export const ANTHROPIC_API_BASE = "https://api.anthropic.com";
export const ANTHROPIC_API_VERSION = "2023-06-01";
/** The Usage and Cost Analytics API is in beta and needs this on every request. */
export const ANALYTICS_BETA = "analytics-usage-cost-2026-08-24";
export const SPEND_TIMEOUT_MS = 10_000;
/** A runaway pagination guard; an organization with 10k keys is not this tool's case. */
const MAX_PAGES = 100;

export interface SpendOptions {
	fetchImpl?: typeof fetch;
	/** Base URL override for tests (loopback server). */
	apiBase?: string;
	timeoutMs?: number;
}

export type SpendResult =
	| { ok: true; cents: number; dataRefreshedAt?: Date }
	| { ok: false; error: string };

/** The Admin API list-keys URL; also the Admin key's live check (DEC-016). */
export function apiKeysUrl(apiBase: string = ANTHROPIC_API_BASE): string {
	return `${apiBase}/v1/organizations/api_keys`;
}

export function adminHeaders(adminKey: string): Record<string, string> {
	return {
		"x-api-key": adminKey,
		"anthropic-version": ANTHROPIC_API_VERSION,
		"anthropic-beta": ANALYTICS_BETA,
		Accept: "application/json",
		"User-Agent": "pi-seat",
	};
}

/** Does a `partial_key_hint` like `sk-ant-api03-R2D...igAA` describe `key`? */
export function matchesKeyHint(hint: unknown, key: string): boolean {
	if (typeof hint !== "string") return false;
	const parts = hint.split("...");
	if (parts.length !== 2) return false;
	const [prefix, suffix] = parts as [string, string];
	if (prefix.length === 0 || suffix.length === 0) return false;
	return key.length >= prefix.length + suffix.length && key.startsWith(prefix) && key.endsWith(suffix);
}

class SpendError extends Error {}

/** Spend of `key` since `start`, read with `adminKey`. Never rejects. */
export async function fetchKeySpend(key: string, adminKey: string, start: Date, options: SpendOptions = {}): Promise<SpendResult> {
	try {
		const id = await findApiKeyId(key, adminKey, options);
		return await sumCost(id, adminKey, start, options);
	} catch (error) {
		const message = error instanceof SpendError ? error.message : `request failed (${errorText(error)})`;
		return { ok: false, error: redactTokenText(message, [key, adminKey]) };
	}
}

async function findApiKeyId(key: string, adminKey: string, options: SpendOptions): Promise<string> {
	const matches: string[] = [];
	let afterId: string | undefined;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const query = new URLSearchParams({ limit: "100" });
		if (afterId !== undefined) query.set("after_id", afterId);
		const body = await getAdminJson(`${apiKeysUrl(options.apiBase)}?${query}`, adminKey, options);
		const data = Array.isArray(body["data"]) ? (body["data"] as Record<string, unknown>[]) : undefined;
		if (data === undefined) throw new SpendError("unreadable API key list");
		for (const entry of data) {
			if (entry["status"] === "active" && typeof entry["id"] === "string" && matchesKeyHint(entry["partial_key_hint"], key)) {
				matches.push(entry["id"]);
			}
		}
		if (body["has_more"] !== true) return onlyMatch(matches);
		if (typeof body["last_id"] !== "string") throw new SpendError("API key list ended without a cursor");
		afterId = body["last_id"];
	}
	throw new SpendError("API key list too long to search");
}

function onlyMatch(matches: string[]): string {
	if (matches.length === 0) throw new SpendError("key not found among the active keys of this Admin key's organization");
	if (matches.length > 1) throw new SpendError("several keys in the organization match this key's hint");
	return matches[0]!;
}

async function sumCost(apiKeyId: string, adminKey: string, start: Date, options: SpendOptions): Promise<SpendResult> {
	const base = `${options.apiBase ?? ANTHROPIC_API_BASE}/v1/organizations/analytics/cost`;
	let cents = 0;
	let dataRefreshedAt: Date | undefined;
	let page: string | undefined;
	for (let count = 0; count < MAX_PAGES; count += 1) {
		const query = new URLSearchParams({ starting_at: start.toISOString(), limit: "1000" });
		query.append("api_key_ids[]", apiKeyId);
		if (page !== undefined) query.set("page", page);
		const body = await getAdminJson(`${base}?${query}`, adminKey, options);
		const rows = Array.isArray(body["data"]) ? (body["data"] as Record<string, unknown>[]) : undefined;
		if (rows === undefined) throw new SpendError("unreadable cost report");
		for (const row of rows) {
			const cost = row["cost"] as Record<string, unknown> | undefined;
			const amount = Number(cost?.["amount"]);
			if (typeof cost?.["amount"] !== "string" || !Number.isFinite(amount)) throw new SpendError("unreadable cost amount");
			cents += amount;
		}
		const refreshed = body["data_refreshed_at"];
		if (typeof refreshed === "string" && !Number.isNaN(Date.parse(refreshed))) dataRefreshedAt = new Date(refreshed);
		if (body["has_more"] !== true) return dataRefreshedAt === undefined ? { ok: true, cents } : { ok: true, cents, dataRefreshedAt };
		if (typeof body["next_page"] !== "string") throw new SpendError("cost report ended without a cursor");
		page = body["next_page"];
	}
	throw new SpendError("cost report too long to total");
}

async function getAdminJson(url: string, adminKey: string, options: SpendOptions): Promise<Record<string, unknown>> {
	const response = await (options.fetchImpl ?? fetch)(url, {
		headers: adminHeaders(adminKey),
		signal: AbortSignal.timeout(options.timeoutMs ?? SPEND_TIMEOUT_MS),
	});
	if (!response.ok) {
		const why =
			response.status === 401 ? "Admin key rejected" : response.status === 403 ? "Admin key not allowed" : "Admin API error";
		throw new SpendError(`${why} (HTTP ${response.status})`);
	}
	const body: unknown = await response.json().catch(() => undefined);
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new SpendError("unreadable Admin API reply");
	return body as Record<string, unknown>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Cents as dollars with two decimals: 2234 → "$22.34". */
export function formatDollars(cents: number): string {
	return `$${(Math.round(cents) / 100).toFixed(2)}`;
}
