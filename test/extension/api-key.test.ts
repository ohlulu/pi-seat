/**
 * REQ-013 login gates (DEC-015): the key's shape, the live check, and the
 * masked input that reads it. Every key here is fake; no request leaves the
 * process.
 */
import { describe, expect, test } from "bun:test";
import {
	ANTHROPIC_API_VERSION,
	ANTHROPIC_MODELS_URL,
	apiKeyCredential,
	apiKeyShapeProblem,
	assertApiKeyProvider,
	verifyApiKey,
} from "../../src/extension/api-key.ts";
import { SECRET_INPUT_LEGEND, SecretInput } from "../../src/extension/secret-input.ts";
import { redactTokenText } from "../../src/store/redact.ts";
import { visibleCellWidth } from "../../src/usage/cells.ts";

const KEY = "sk-ant-api03-FAKE-test-key-0000";

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected a rejection");
}

function recordingFetch(response: () => Response | Promise<Response>) {
	const sent: { url: string; headers: Record<string, string> }[] = [];
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		sent.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
		return response();
	}) as unknown as typeof fetch;
	return { sent, fetchImpl };
}

describe("REQ-013: key shape", () => {
	test("Console key shapes pass; the live check decides the rest", () => {
		expect(apiKeyShapeProblem("sk-ant-api03-abc")).toBeUndefined();
		expect(apiKeyShapeProblem("sk-ant-usr-abc")).toBeUndefined();
		expect(apiKeyShapeProblem("sk-ant-sa-abc")).toBeUndefined();
	});

	test("AC-042: OAuth tokens, Admin keys, foreign strings and whitespace are refused", () => {
		expect(apiKeyShapeProblem("sk-ant-oat01-abc")).toContain("OAuth token");
		expect(apiKeyShapeProblem("sk-ant-admin01-abc")).toContain("Admin API key");
		expect(apiKeyShapeProblem("sk-proj-abc")).toContain('starts with "sk-ant-"');
		expect(apiKeyShapeProblem("")).toContain("empty");
		expect(apiKeyShapeProblem("sk-ant-api03-a b")).toContain("whitespace");
	});

	test("only anthropic takes an API key", () => {
		expect(() => assertApiKeyProvider("anthropic")).not.toThrow();
		expect(() => assertApiKeyProvider("openai-codex")).toThrow("OAuth only");
	});
});

describe("REQ-013: live check", () => {
	test("sends the key as x-api-key to the tokenless models endpoint", async () => {
		const { sent, fetchImpl } = recordingFetch(() => Response.json({ data: [] }));
		await verifyApiKey(KEY, { fetchImpl });
		expect(sent).toHaveLength(1);
		expect(sent[0]!.url).toBe(ANTHROPIC_MODELS_URL);
		expect(sent[0]!.headers["x-api-key"]).toBe(KEY);
		expect(sent[0]!.headers["anthropic-version"]).toBe(ANTHROPIC_API_VERSION);
		expect(sent[0]!.headers["Authorization"]).toBeUndefined();
	});

	test("AC-042: a 401 is refused and the message never carries the key", async () => {
		const { fetchImpl } = recordingFetch(() => new Response("{}", { status: 401 }));
		const error = await rejection(verifyApiKey(KEY, { fetchImpl }));
		expect(error.message).toContain("HTTP 401");
		expect(error.message).toContain("nothing stored");
		expect(error.message).not.toContain(KEY);
	});

	test("a network failure echoing the key is redacted", async () => {
		const fetchImpl = (async () => {
			throw new Error(`connect failed for ${KEY}`);
		}) as unknown as typeof fetch;
		const error = await rejection(verifyApiKey(KEY, { fetchImpl }));
		expect(error.message).toContain("could not reach Anthropic");
		expect(error.message).not.toContain(KEY);
	});

	test("apiKeyCredential trims, checks the shape before any request, then verifies", async () => {
		const { sent, fetchImpl } = recordingFetch(() => Response.json({ data: [] }));
		expect(await apiKeyCredential(`  ${KEY}\n`, { fetchImpl })).toEqual({ type: "api_key", key: KEY });

		await expect(apiKeyCredential("sk-ant-oat01-abc", { fetchImpl })).rejects.toThrow("OAuth token");
		expect(sent).toHaveLength(1); // the refused shape sent nothing
	});
});

describe("redaction covers Anthropic keys without an exact secret list", () => {
	test("sk-ant-… is masked by pattern", () => {
		expect(redactTokenText(`bad key ${KEY} here`)).toBe("bad key sk-ant-<redacted> here");
		expect(redactTokenText("token sk-ant-oat01-abc.def")).toBe("token sk-ant-<redacted>");
	});
});

describe("REQ-013: masked input", () => {
	function open() {
		const result: { submitted?: string; cancelled: boolean } = { cancelled: false };
		const view = new SecretInput("Anthropic Console API key", {
			onSubmit: (value) => void (result.submitted = value),
			onCancel: () => void (result.cancelled = true),
		});
		return { view, result };
	}

	test("typed and pasted characters render as bullets, never as the key", () => {
		const { view, result } = open();
		view.handleInput("s");
		view.handleInput("k");
		view.handleInput(`\x1b[200~${KEY.slice(2)}\x1b[201~`);
		const rows = view.render(80);
		expect(rows.join("\n")).not.toContain("sk-");
		expect(rows[1]).toBe(`> ${"•".repeat(KEY.length)}`);
		expect(rows[2]).toBe(SECRET_INPUT_LEGEND);

		view.handleInput("\r");
		expect(result.submitted).toBe(KEY);
	});

	test("backspace edits the hidden value; escape cancels", () => {
		const { view, result } = open();
		for (const char of "abc") view.handleInput(char);
		view.handleInput("\x7f");
		expect(view.render(80)[1]).toBe("> ••");
		view.handleInput("\x1b");
		expect(result.cancelled).toBe(true);
		expect(result.submitted).toBeUndefined();
	});

	test("no row overflows at any width", () => {
		const { view } = open();
		view.handleInput(`\x1b[200~${KEY.repeat(4)}\x1b[201~`);
		for (let width = 0; width <= 120; width += 1) {
			for (const row of view.render(width)) expect(visibleCellWidth(row)).toBeLessThanOrEqual(width);
		}
	});
});
