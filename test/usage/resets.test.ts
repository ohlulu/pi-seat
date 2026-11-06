/**
 * REQ-012: banked limit resets — lookup and redeem wire contracts for both
 * providers, outcome mapping, and the credential each reset rides on.
 *
 * Run: bun test test/usage/resets.test.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";
import { InMemorySeatStorageBackend, encodeStore } from "../../src/store/storage.ts";
import { createStoreSchedule } from "../../src/store/scheduler.ts";
import { CLAUDE_CLI_USER_AGENT } from "../../src/usage/fetch.ts";
import {
	CODEX_RESET_CONSUME_URL,
	CODEX_RESET_CREDITS_URL,
	findResetOffer,
	redeemReset,
	resetCredential,
	type ResetOffer,
} from "../../src/usage/resets.ts";

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

interface Sent {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

/** A fetch that records every request and answers from `routes` by `METHOD url`. */
function mockFetch(routes: Record<string, () => Response>): { fetchImpl: typeof fetch; sent: Sent[] } {
	const sent: Sent[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
		sent.push({ method, url, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
		const route = routes[`${method} ${url}`];
		return route ? route() : new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetchImpl, sent };
}

function cred(name: string, extra: Record<string, unknown> = {}): SeatCredential {
	return { type: "oauth", refresh: `rt-${name}`, access: `at-${name}`, expires: NOW + 3_600_000, ...extra } as SeatCredential;
}

const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1";
const CLAUDE_PROFILE = "https://api.anthropic.com/api/oauth/profile";
const ORG = "6f1c2a40-1111-4222-8333-944455556666";
const CLAUDE_REDEEM = `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`;

function claudeStatus(cedar: unknown): () => Response {
	return () => Response.json({ limits: [], cedar_ember: cedar });
}

const GRANT = {
	id: "grant_a1",
	label: "Opus 5.5 launch reset",
	resets_total: 1,
	resets_left: 1,
	ends_at: "2026-11-30T00:00:00+00:00",
	clears: ["five_hour", "seven_day"],
	paused: false,
	usable_now: true,
	use_requires_limit: false,
};

const opts = (fetchImpl: typeof fetch) => ({ fetchImpl, now: () => NOW, requestId: () => "req-fixed-1" });

describe("Codex: lookup", () => {
	test("offers the available credit closest to expiring, by id, with the account header", async () => {
		const { fetchImpl, sent } = mockFetch({
			[`GET ${CODEX_RESET_CREDITS_URL}`]: () =>
				Response.json({
					available_count: 2,
					credits: [
						{ id: "late", status: "available", expires_at: "2026-12-01T20:32:49Z", title: "Full reset (Weekly + 5 hr)" },
						{ id: "spent", status: "redeemed", expires_at: "2026-11-10T00:00:00Z" },
						{ id: "soon", status: "available", expires_at: "2026-11-30T17:36:26Z", title: "Full reset (Weekly + 5 hr)" },
					],
				}),
		});
		const lookup = await findResetOffer("openai-codex", cred("c", { accountId: "acct-9" }), opts(fetchImpl));
		expect(lookup.kind).toBe("offer");
		if (lookup.kind !== "offer") throw new Error("unreachable");
		expect(lookup.offer).toMatchObject({ provider: "openai-codex", id: "soon", title: "Full reset (Weekly + 5 hr)", remaining: 2 });
		expect(lookup.offer.expiresAt?.toISOString()).toBe("2026-11-30T17:36:26.000Z");
		// Codex only spends a credit that refills something; the confirmation says so.
		expect(lookup.offer.caveat).toContain("only if it refills");
		expect(sent[0]!.headers["authorization"]).toBe("Bearer at-c");
		expect(sent[0]!.headers["chatgpt-account-id"]).toBe("acct-9");
	});

	test("an unreadable list is a failed lookup, never 'none'", async () => {
		for (const response of [new Response("<html>oops</html>", { status: 200 }), Response.json({ available_count: 2 })]) {
			const { fetchImpl } = mockFetch({ [`GET ${CODEX_RESET_CREDITS_URL}`]: () => response });
			await expect(findResetOffer("openai-codex", cred("c"), opts(fetchImpl))).rejects.toThrow("unreadable reset list");
		}
	});

	test("no available credit is a plain 'none', not an error", async () => {
		const { fetchImpl } = mockFetch({
			[`GET ${CODEX_RESET_CREDITS_URL}`]: () => Response.json({ available_count: 0, credits: [{ id: "x", status: "redeemed" }] }),
		});
		expect(await findResetOffer("openai-codex", cred("c"), opts(fetchImpl))).toEqual({
			kind: "none",
			message: "no usage limit resets available",
		});
	});
});

const CODEX_OFFER: ResetOffer = {
	provider: "openai-codex",
	id: "soon",
	title: "Full reset (Weekly + 5 hr)",
	expiresAt: null,
	remaining: 2,
	refills: [],
};

describe("Codex: redeem", () => {
	test("POSTs the idempotency key and the exact credit id; `reset` is used", async () => {
		const { fetchImpl, sent } = mockFetch({
			[`POST ${CODEX_RESET_CONSUME_URL}`]: () => Response.json({ code: "reset", windows_reset: 2, credit: { id: "soon" } }),
		});
		const outcome = await redeemReset(cred("c"), CODEX_OFFER, [], opts(fetchImpl));
		expect(outcome).toEqual({ used: true, message: "reset used · 2 windows refilled" });
		expect(sent).toHaveLength(1);
		expect(sent[0]!.body).toEqual({ redeem_request_id: "req-fixed-1", credit_id: "soon" });
		expect(sent[0]!.headers["content-type"]).toBe("application/json");
	});

	test("server refusals keep the reset; refusing statuses say nothing was used", async () => {
		for (const [response, message] of [
			[Response.json({ code: "nothing_to_reset" }), "nothing to reset right now · reset kept"],
			[Response.json({ code: "already_redeemed" }), "that reset was already used"],
			[Response.json({ code: "no_credit" }), "no usage limit resets available"],
			[new Response("slow down", { status: 429 }), "rate limited · nothing was used · try again in a moment"],
		] as const) {
			const { fetchImpl } = mockFetch({ [`POST ${CODEX_RESET_CONSUME_URL}`]: () => response });
			expect(await redeemReset(cred("c"), CODEX_OFFER, [], opts(fetchImpl))).toEqual({ used: false, message });
		}
	});

	test("an ambiguous failure is 'not confirmed', never 'nothing was used'", async () => {
		for (const response of [new Response("boom", { status: 502 }), Response.json({ code: "brand_new_code" })]) {
			const { fetchImpl } = mockFetch({ [`POST ${CODEX_RESET_CONSUME_URL}`]: () => response });
			const outcome = await redeemReset(cred("c"), CODEX_OFFER, [], opts(fetchImpl));
			expect(outcome.used).toBe(false);
			expect(outcome.message).toStartWith("reset not confirmed:");
			expect(outcome.message).toContain("press r to check");
		}
	});

	test("a transport error that echoes the token is redacted", async () => {
		const fetchImpl = (async () => {
			throw new Error("socket closed while sending Bearer at-leaky-token");
		}) as unknown as typeof fetch;
		const outcome = await redeemReset(cred("leaky-token"), CODEX_OFFER, ["at-leaky-token"], opts(fetchImpl));
		expect(outcome.message).not.toContain("at-leaky-token");
	});
});

describe("Anthropic: lookup", () => {
	test("offers the grant the server names next, with the Claude Code identity", async () => {
		const { fetchImpl, sent } = mockFetch({
			[`GET ${CLAUDE_USAGE}`]: claudeStatus({
				eligible: true,
				at_limit: true,
				grants: [{ ...GRANT, id: "grant_other" }, GRANT],
				next_grant_id: "grant_a1",
			}),
		});
		const lookup = await findResetOffer("anthropic", cred("a"), opts(fetchImpl));
		if (lookup.kind !== "offer") throw new Error(`expected an offer, got ${JSON.stringify(lookup)}`);
		expect(lookup.offer).toMatchObject({
			provider: "anthropic",
			id: "grant_a1",
			title: "Opus 5.5 launch reset",
			refills: ["5h", "weekly"],
		});
		expect(lookup.offer.caveat).toBeUndefined();
		// Account-wide count, matching the credits row: both grants hold one each.
		expect(lookup.offer.remaining).toBe(2);
		expect(sent[0]!.headers["user-agent"]).toBe(CLAUDE_CLI_USER_AGENT);
		expect(sent[0]!.headers["x-app"]).toBe("cli");
	});

	test("caveats: a limit-only reset away from a limit, an early reset, a pending cooldown", async () => {
		const cases = [
			[{ at_limit: false, grant: { use_requires_limit: true } }, "works only at a usage limit"],
			[{ at_limit: false, grant: { use_requires_limit: false } }, "not reached a limit yet"],
			[{ at_limit: true, cooldown_until: new Date(NOW + 60_000).toISOString(), grant: {} }, "still going through"],
		] as const;
		for (const [shape, caveat] of cases) {
			const { fetchImpl } = mockFetch({
				[`GET ${CLAUDE_USAGE}`]: claudeStatus({
					eligible: true,
					at_limit: shape.at_limit,
					cooldown_until: "cooldown_until" in shape ? shape.cooldown_until : null,
					grants: [{ ...GRANT, ...shape.grant }],
					next_grant_id: GRANT.id,
				}),
			});
			const lookup = await findResetOffer("anthropic", cred("a"), opts(fetchImpl));
			if (lookup.kind !== "offer") throw new Error("expected an offer");
			expect(lookup.offer.caveat).toContain(caveat);
		}
	});

	test("a present but unreadable reset block is a failed lookup, never 'none'", async () => {
		for (const cedar of [{ eligible: true, grants: {}, next_grant_id: "grant_a1" }, { eligible: true }, "garbage"]) {
			const { fetchImpl } = mockFetch({ [`GET ${CLAUDE_USAGE}`]: claudeStatus(cedar) });
			await expect(findResetOffer("anthropic", cred("a"), opts(fetchImpl))).rejects.toThrow("unreadable reset status");
		}
	});

	test("no grant, an ineligible client, or a paused grant is 'none' with the reason in words", async () => {
		const cases = [
			[{ eligible: false, ineligible_reason: "no_grant", grants: [], next_grant_id: null }, "no limit resets available"],
			[{ eligible: false, ineligible_reason: "surface", grants: [], next_grant_id: null }, "does not offer resets to this client"],
			[{ eligible: false, ineligible_reason: "cli_version", grants: [], next_grant_id: null }, "update pi-seat"],
			[{ eligible: true, grants: [{ ...GRANT, paused: true }], next_grant_id: GRANT.id }, "paused"],
			// A grant the server did not name next would be refused as `not_next_grant`.
			[{ eligible: true, grants: [GRANT], next_grant_id: null }, "no limit resets available"],
			[null, "no limit-reset program"],
		] as const;
		for (const [cedar, message] of cases) {
			const { fetchImpl } = mockFetch({ [`GET ${CLAUDE_USAGE}`]: claudeStatus(cedar) });
			const lookup = await findResetOffer("anthropic", cred("a"), opts(fetchImpl));
			expect(lookup.kind).toBe("none");
			if (lookup.kind === "none") expect(lookup.message).toContain(message);
		}
	});
});

const CLAUDE_OFFER: ResetOffer = {
	provider: "anthropic",
	id: "grant_a1",
	title: "Opus 5.5 launch reset",
	expiresAt: null,
	remaining: 1,
	refills: ["5h", "weekly"],
};

describe("Anthropic: redeem", () => {
	test("resolves the organization, then POSTs program, grant and idempotency key", async () => {
		const { fetchImpl, sent } = mockFetch({
			[`GET ${CLAUDE_PROFILE}`]: () => Response.json({ account: { uuid: "acct" }, organization: { uuid: ORG } }),
			[`POST ${CLAUDE_REDEEM}`]: () => Response.json({ result: "reset", resets_left: 0, cleared: ["five_hour", "seven_day"] }),
		});
		const outcome = await redeemReset(cred("a"), CLAUDE_OFFER, [], opts(fetchImpl));
		expect(outcome).toEqual({ used: true, message: "reset used · 5h, weekly refilled · 0 left" });
		expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([`GET ${CLAUDE_PROFILE}`, `POST ${CLAUDE_REDEEM}`]);
		expect(sent[1]!.body).toEqual({ program: "cedar_ember", grant_id: "grant_a1", request_id: "req-fixed-1" });
		expect(sent[1]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
		expect(sent[1]!.headers["user-agent"]).toBe(CLAUDE_CLI_USER_AGENT);
	});

	test("every refusal result keeps the reset", async () => {
		for (const [body, message] of [
			[{ result: "not_limited" }, "not at a usage limit · reset kept"],
			[{ result: "already_used" }, "that reset was already used · nothing changed"],
			[{ result: "cooldown" }, "another reset just went through"],
			[{ result: "ineligible", reason: "tier" }, "not eligible (tier) · nothing was used"],
			[{ result: "unavailable" }, "reset unavailable right now · nothing was used"],
		] as const) {
			const { fetchImpl } = mockFetch({
				[`GET ${CLAUDE_PROFILE}`]: () => Response.json({ organization: { uuid: ORG } }),
				[`POST ${CLAUDE_REDEEM}`]: () => Response.json(body),
			});
			const outcome = await redeemReset(cred("a"), CLAUDE_OFFER, [], opts(fetchImpl));
			expect(outcome.used).toBe(false);
			expect(outcome.message).toContain(message);
		}
	});

	test("a failure before the POST says nothing was used, not 'not confirmed'", async () => {
		const { fetchImpl, sent } = mockFetch({ [`GET ${CLAUDE_PROFILE}`]: () => new Response("no", { status: 401 }) });
		const outcome = await redeemReset(cred("a"), CLAUDE_OFFER, [], opts(fetchImpl));
		expect(outcome.used).toBe(false);
		expect(outcome.message).toStartWith("could not start the reset:");
		expect(outcome.message).toEndWith("nothing was used");
		expect(sent.some((s) => s.method === "POST")).toBe(false);
	});

	test("401 is a refusal; a login without an organization never reaches the redeem", async () => {
		const refused = mockFetch({
			[`GET ${CLAUDE_PROFILE}`]: () => Response.json({ organization: { uuid: ORG } }),
			[`POST ${CLAUDE_REDEEM}`]: () => new Response("no", { status: 401 }),
		});
		expect((await redeemReset(cred("a"), CLAUDE_OFFER, [], opts(refused.fetchImpl))).message).toContain("nothing was used");

		const orgless = mockFetch({ [`GET ${CLAUDE_PROFILE}`]: () => Response.json({ organization: { uuid: "../../evil" } }) });
		const outcome = await redeemReset(cred("a"), CLAUDE_OFFER, [], opts(orgless.fetchImpl));
		expect(outcome.used).toBe(false);
		expect(outcome.message).toContain("no organization");
		expect(outcome.message).toContain("nothing was used");
		expect(orgless.sent.some((s) => s.method === "POST")).toBe(false);
	});
});

describe("the credential a reset rides on", () => {
	test("built-in: read from the auth.json snapshot, never refreshed; expired only explains", async () => {
		const dir = mkdtempSync(join(tmpdir(), "seat-resets-"));
		try {
			const authPath = join(dir, "auth.json");
			writeFileSync(authPath, JSON.stringify({ "openai-codex": cred("builtin", { accountId: "acct-b" }) }), { mode: 0o600 });
			const refreshCalls: string[] = [];
			const deps = {
				backend: new InMemorySeatStorageBackend(),
				authPath,
				schedule: createStoreSchedule(),
				refreshFor: () => async (c: SeatCredential) => {
					refreshCalls.push(c.refresh);
					return c;
				},
				fetchOptions: { now: () => NOW },
			};
			const live = await resetCredential(deps, { provider: "openai-codex", kind: "builtin" });
			expect(live.ok && live.credential.access).toBe("at-builtin");

			writeFileSync(authPath, JSON.stringify({ "openai-codex": cred("dead", { expires: NOW - 1 }) }), { mode: 0o600 });
			const before = readFileSync(authPath);
			const expired = await resetCredential(deps, { provider: "openai-codex", kind: "builtin" });
			expect(expired).toEqual({ ok: false, message: expect.stringContaining("seat never touches Pi's grant") });
			expect(refreshCalls).toEqual([]);
			expect(readFileSync(authPath).equals(before)).toBe(true); // AC-001: seat never writes auth.json
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("stored profile: an expired grant is refreshed through the REQ-005 path first", async () => {
		const backend = new InMemorySeatStorageBackend();
		const store = emptyStore();
		store.providers.anthropic = {
			profiles: Object.assign(Object.create(null), { work: cred("w", { expires: NOW - 1 }) }),
			aliases: Object.create(null),
		};
		backend.withLock(() => ({ result: undefined, next: encodeStore(store) }));
		const result = await resetCredential(
			{
				backend,
				authPath: "/nonexistent/auth.json",
				schedule: createStoreSchedule(),
				refreshFor: () => async (c) => ({ ...c, access: "at-rotated", expires: NOW + 3_600_000 }),
				fetchOptions: { now: () => NOW },
			},
			{ provider: "anthropic", kind: "profile", label: "work" },
		);
		expect(result.ok && result.credential.access).toBe("at-rotated");
	});
});
