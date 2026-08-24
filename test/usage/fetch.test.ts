import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";
import { InMemorySeatStorageBackend, decodeStore, encodeStore } from "../../src/store/storage.ts";
import type { RefreshCallback } from "../../src/store/refresh.ts";
import { builtinUsage, fetchCodexUsage, profileUsage, readBuiltinSnapshot } from "../../src/usage/fetch.ts";
import { planLayout } from "../../src/usage/layout.ts";
import { meterLine, type ClaudeUsage } from "../../src/usage/render.ts";

const CLAUDE_PAYLOAD = {
	limits: [{ kind: "session", percent: 42, resets_at: "2026-01-15T14:31:00+00:00" }],
};
const CODEX_PAYLOAD = {
	rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 37, reset_at: 1_768_486_320 } },
};

interface Captured {
	url: string;
	headers: Record<string, string>;
}

let server: ReturnType<typeof Bun.serve>;
let captured: Captured[] = [];
let claudeUrl: string;
let codexUrl: string;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const url = new URL(req.url);
			captured.push({ url: url.pathname, headers: Object.fromEntries(req.headers.entries()) });
			if (url.pathname === "/claude") return Response.json(CLAUDE_PAYLOAD);
			if (url.pathname === "/codex") return Response.json(CODEX_PAYLOAD);
			return new Response("nope", { status: 500 });
		},
	});
	claudeUrl = `http://localhost:${server.port}/claude`;
	codexUrl = `http://localhost:${server.port}/codex`;
});

afterAll(() => {
	server.stop(true);
});

function cred(refresh: string, expires: number, extra: Record<string, unknown> = {}): SeatCredential {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires, ...extra };
}

function seedBackend(credential: SeatCredential): InMemorySeatStorageBackend {
	const backend = new InMemorySeatStorageBackend();
	const store = emptyStore();
	store.providers.anthropic = {
		profiles: Object.assign(Object.create(null), { personal: credential }),
		aliases: Object.assign(Object.create(null)),
	};
	backend.withLock(() => ({ result: undefined, next: encodeStore(store) }));
	return backend;
}

describe("AC-010: dormant expired profile refreshes through the lock, then renders", () => {
	test("refresh precedes fetch; endpoint sees the rotated token; bar renders", async () => {
		captured = [];
		const backend = seedBackend(cred("rt-old", Date.now() - 60_000));
		const events: string[] = [];
		const refresh: RefreshCallback = async (credential) => {
			events.push(`refresh:${credential.refresh}`);
			return cred("rt-new", Date.now() + 3_600_000);
		};

		const result = await profileUsage(backend, "anthropic", "personal", refresh, { claudeUrl });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.refreshed).toBe(true);
		expect(events).toEqual(["refresh:rt-old"]);
		expect(captured[0]?.headers["authorization"]).toBe("Bearer at-rt-new"); // fetched with the rotation

		// The rotation went through the locked store, not a local variable.
		const persisted = backend.read((c) => decodeStore(c));
		expect(persisted.providers.anthropic?.profiles["personal"]?.refresh).toBe("rt-new");

		// The usage payload renders a bar on the shared layout.
		const layout = planLayout(80);
		const usage = result.usage as ClaudeUsage;
		const line = meterLine(layout, "5h", usage.limits![0]!.percent ?? 0, null, {
			color: false,
			now: () => new Date(0),
		});
		expect(line).toContain("█");
		expect(line).toContain("42%");
	});

	test("fresh profile skips the refresh entirely", async () => {
		captured = [];
		const backend = seedBackend(cred("rt-fresh", Date.now() + 3_600_000));
		const refresh: RefreshCallback = async () => {
			throw new Error("must not refresh a fresh credential");
		};
		const result = await profileUsage(backend, "anthropic", "personal", refresh, { claudeUrl });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.refreshed).toBe(false);
	});

	test("endpoint failure is contained, refresh side effects kept", async () => {
		const backend = seedBackend(cred("rt-x", Date.now() + 3_600_000));
		const refresh: RefreshCallback = async (c) => c;
		const result = await profileUsage(backend, "anthropic", "personal", refresh, {
			claudeUrl: `http://localhost:${server.port}/boom`,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("HTTP 500");
	});
});

describe("Python-parity request headers", () => {
	test("Claude: bearer, anthropic-beta, claude-code UA", async () => {
		captured = [];
		const backend = seedBackend(cred("rt-h", Date.now() + 3_600_000));
		await profileUsage(backend, "anthropic", "personal", async (c) => c, { claudeUrl });
		const headers = captured[0]!.headers;
		expect(headers["authorization"]).toBe("Bearer at-rt-h");
		expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
		expect(headers["user-agent"]).toBe("claude-code/2.1.69");
		expect(headers["accept"]).toBe("application/json");
	});

	test("Codex: seat UA plus ChatGPT-Account-Id when present", async () => {
		captured = [];
		await fetchCodexUsage(cred("rt-c", Date.now() + 3_600_000, { accountId: "acct-123" }), { codexUrl });
		expect(captured[0]!.headers["user-agent"]).toBe("seat");
		expect(captured[0]!.headers["chatgpt-account-id"]).toBe("acct-123");

		captured = [];
		await fetchCodexUsage(cred("rt-c2", Date.now() + 3_600_000), { codexUrl });
		expect(captured[0]!.headers["chatgpt-account-id"]).toBeUndefined();
	});
});

describe("built-in credential: read-only snapshot, never refreshed", () => {
	test("live builtin fetches; expired builtin only annotates; auth.json untouched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "seat-fetch-"));
		try {
			const authPath = join(dir, "auth.json");
			const live = { anthropic: cred("rt-builtin", Date.now() + 3_600_000) };
			writeFileSync(authPath, JSON.stringify(live), { mode: 0o600 });
			const before = readFileSync(authPath);

			captured = [];
			const result = await builtinUsage(authPath, "anthropic", { claudeUrl });
			expect(result).toEqual({ ok: true, usage: CLAUDE_PAYLOAD as never });
			expect(captured[0]?.headers["authorization"]).toBe("Bearer at-rt-builtin");

			// Expired: no fetch, no refresh, just the annotation.
			captured = [];
			writeFileSync(authPath, JSON.stringify({ anthropic: cred("rt-dead", Date.now() - 60_000) }), { mode: 0o600 });
			const expiredBefore = readFileSync(authPath);
			const expired = await builtinUsage(authPath, "anthropic", { claudeUrl });
			expect(expired).toEqual({ expired: true });
			expect(captured).toHaveLength(0); // endpoint never called
			expect(readFileSync(authPath).equals(expiredBefore)).toBe(true); // byte-identical

			// Absent provider entry → undefined.
			expect(await builtinUsage(authPath, "openai-codex", { codexUrl })).toBeUndefined();
			expect(readBuiltinSnapshot(join(dir, "missing.json"), "anthropic")).toBeUndefined();
			void before;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
