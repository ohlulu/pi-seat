/**
 * REQ-014 spend transport (DEC-016): key → api_key_id through the hint, cost
 * totals, pagination, and failures that never echo a key. Every key is fake; no
 * request leaves the process. Run: bun test test/usage/spend.test.ts
 */
import { describe, expect, test } from "bun:test";
import { ANALYTICS_BETA, fetchKeySpend, formatDollars, matchesKeyHint } from "../../src/usage/spend.ts";

const KEY = "sk-ant-api03-FAKE-spend-key-wxyz";
const ADMIN = "sk-ant-admin01-FAKE-admin-key";
const START = new Date("2026-11-26T16:00:00Z");

interface Sent {
	url: URL;
	headers: Record<string, string>;
}

function fakeAdminApi(routes: { keys?: unknown[]; cost?: unknown[]; status?: number }): { fetchImpl: typeof fetch; sent: Sent[] } {
	const sent: Sent[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		sent.push({ url, headers: init?.headers as Record<string, string> });
		if (routes.status !== undefined) return new Response("{}", { status: routes.status });
		if (url.pathname === "/v1/organizations/api_keys") {
			const pages = routes.keys ?? [];
			const index = url.searchParams.has("after_id") ? Number(url.searchParams.get("after_id")) : 0;
			return Response.json(pages[index]);
		}
		if (url.pathname === "/v1/organizations/analytics/cost") {
			const pages = routes.cost ?? [];
			const index = url.searchParams.has("page") ? Number(url.searchParams.get("page")) : 0;
			return Response.json(pages[index]);
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
	return { fetchImpl, sent };
}

function keyEntry(id: string, hint: string, status = "active") {
	return { type: "api_key", id, partial_key_hint: hint, status };
}

function costRow(amount: string) {
	return { cost: { amount, list_amount: amount, currency: "USD", requests: 1 } };
}

describe("matchesKeyHint", () => {
	test("prefix and suffix around the elision", () => {
		expect(matchesKeyHint("sk-ant-api03-FAK...wxyz", KEY)).toBe(true);
		expect(matchesKeyHint("sk-ant-api03-FAK...abcd", KEY)).toBe(false);
		expect(matchesKeyHint("sk-ant-api03-ZZZ...wxyz", KEY)).toBe(false);
	});

	test("missing or malformed hints match nothing", () => {
		for (const hint of [null, undefined, "", "sk-ant-api03-FAK", "...wxyz", "sk-ant...", "a...b...c"]) {
			expect(matchesKeyHint(hint, KEY)).toBe(false);
		}
	});
});

describe("fetchKeySpend", () => {
	test("AC-048: finds the id across pages and totals every cost row", async () => {
		const { fetchImpl, sent } = fakeAdminApi({
			keys: [
				{ data: [keyEntry("apikey_other", "sk-ant-api03-ABC...1234")], has_more: true, last_id: "1" },
				{ data: [keyEntry("apikey_old", "sk-ant-api03-FAK...wxyz", "archived"), keyEntry("apikey_me", "sk-ant-api03-FAK...wxyz")], has_more: false },
			],
			cost: [
				{ data: [costRow("1234.000000")], has_more: true, next_page: "1" },
				{ data: [costRow("1000.000000")], has_more: false, data_refreshed_at: "2026-11-30T06:05:00Z" },
			],
		});

		const result = await fetchKeySpend(KEY, ADMIN, START, { fetchImpl, apiBase: "http://admin.test" });
		expect(result).toEqual({ ok: true, cents: 2234, dataRefreshedAt: new Date("2026-11-30T06:05:00Z") });
		expect(formatDollars(2234)).toBe("$22.34");

		const costCalls = sent.filter((s) => s.url.pathname.endsWith("/cost"));
		expect(costCalls).toHaveLength(2);
		expect(costCalls[0]!.url.searchParams.getAll("api_key_ids[]")).toEqual(["apikey_me"]);
		expect(costCalls[0]!.url.searchParams.get("starting_at")).toBe(START.toISOString());
		expect(costCalls[0]!.url.searchParams.has("time_bucket_width")).toBe(false);
		for (const call of sent) {
			expect(call.headers["x-api-key"]).toBe(ADMIN);
			expect(call.headers["anthropic-beta"]).toBe(ANALYTICS_BETA);
		}
	});

	test("no cost rows is a real zero", async () => {
		const { fetchImpl } = fakeAdminApi({
			keys: [{ data: [keyEntry("apikey_me", "sk-ant-api03-FAK...wxyz")], has_more: false }],
			cost: [{ data: [], has_more: false }],
		});
		expect(await fetchKeySpend(KEY, ADMIN, START, { fetchImpl, apiBase: "http://admin.test" })).toEqual({ ok: true, cents: 0 });
	});

	test("AC-049: zero or several matching keys are distinct failures", async () => {
		const none = fakeAdminApi({ keys: [{ data: [keyEntry("apikey_x", "sk-ant-api03-ABC...1234")], has_more: false }] });
		const noneResult = await fetchKeySpend(KEY, ADMIN, START, { fetchImpl: none.fetchImpl, apiBase: "http://admin.test" });
		expect(noneResult).toEqual({ ok: false, error: "key not found among the active keys of this Admin key's organization" });

		const many = fakeAdminApi({
			keys: [{ data: [keyEntry("a", "sk-ant-api03-FAK...wxyz"), keyEntry("b", "sk-ant-api03-FA...wxyz")], has_more: false }],
		});
		const manyResult = await fetchKeySpend(KEY, ADMIN, START, { fetchImpl: many.fetchImpl, apiBase: "http://admin.test" });
		expect(manyResult).toEqual({ ok: false, error: "several keys in the organization match this key's hint" });
		expect(many.sent.some((s) => s.url.pathname.endsWith("/cost"))).toBe(false);
	});

	test("AC-049: an HTTP rejection names the status, never a key", async () => {
		const { fetchImpl } = fakeAdminApi({ status: 401 });
		const result = await fetchKeySpend(KEY, ADMIN, START, { fetchImpl, apiBase: "http://admin.test" });
		expect(result).toEqual({ ok: false, error: "Admin key rejected (HTTP 401)" });
	});

	test("a network error is redacted", async () => {
		const fetchImpl = (async () => {
			throw new Error(`connect failed for ${ADMIN} and ${KEY}`);
		}) as unknown as typeof fetch;
		const result = await fetchKeySpend(KEY, ADMIN, START, { fetchImpl });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).not.toContain(ADMIN);
			expect(result.error).not.toContain(KEY);
		}
	});

	test("an unreadable amount fails rather than undercounting", async () => {
		const { fetchImpl } = fakeAdminApi({
			keys: [{ data: [keyEntry("apikey_me", "sk-ant-api03-FAK...wxyz")], has_more: false }],
			cost: [{ data: [costRow("12.5"), { cost: {} }], has_more: false }],
		});
		expect(await fetchKeySpend(KEY, ADMIN, START, { fetchImpl, apiBase: "http://admin.test" })).toEqual({
			ok: false,
			error: "unreadable cost amount",
		});
	});

	test("a page that says there is more but gives no cursor fails instead of returning a partial answer", async () => {
		const keys = fakeAdminApi({ keys: [{ data: [keyEntry("apikey_me", "sk-ant-api03-FAK...wxyz")], has_more: true }] });
		expect(await fetchKeySpend(KEY, ADMIN, START, { fetchImpl: keys.fetchImpl, apiBase: "http://admin.test" })).toEqual({
			ok: false,
			error: "API key list ended without a cursor",
		});

		const cost = fakeAdminApi({
			keys: [{ data: [keyEntry("apikey_me", "sk-ant-api03-FAK...wxyz")], has_more: false }],
			cost: [{ data: [costRow("100.000000")], has_more: true }],
		});
		expect(await fetchKeySpend(KEY, ADMIN, START, { fetchImpl: cost.fetchImpl, apiBase: "http://admin.test" })).toEqual({
			ok: false,
			error: "cost report ended without a cursor",
		});
	});
});
