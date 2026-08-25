import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * T038 / AC-008 runner-level integration: the harness-level "stream zero"
 * assertion was tautological (the harness itself skipped stream() on abort).
 * Here the REAL pi runner drives the turn: a custom provider points at a
 * counting mock endpoint, so "zero provider calls after turn_start abort" is
 * enforced by pi's own agent loop, not by test scaffolding.
 *
 * Control run (extension loaded, nothing to abort) proves the spy counts.
 */

const EXTENSION = new URL("../../src/extension/index.ts", import.meta.url).pathname;

let server: ReturnType<typeof Bun.serve>;
let providerHits = 0;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch: (req) => {
			if (new URL(req.url).pathname.includes("chat/completions")) {
				providerHits += 1;
				const body = [
					`data: {"id":"c1","object":"chat.completion.chunk","model":"mock-1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}`,
					``,
					`data: {"id":"c1","object":"chat.completion.chunk","model":"mock-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
					``,
					`data: [DONE]`,
					``,
				].join("\n");
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			}
			return new Response("not found", { status: 404 });
		},
	});
});

afterAll(() => {
	server.stop(true);
});

function makeSandbox(withSeatProfile: boolean): string {
	const dir = mkdtempSync(join(tmpdir(), "seat-runner-"));
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			providers: {
				mockai: {
					baseUrl: `http://localhost:${server.port}/v1`,
					api: "openai-completions",
					apiKey: "dummy",
					models: [{ id: "mock-1" }],
				},
			},
		}),
		{ mode: 0o600 },
	);
	if (withSeatProfile) {
		writeFileSync(
			join(dir, "seat.json"),
			JSON.stringify({
				version: 1,
				providers: {
					anthropic: {
						profiles: { work: { type: "oauth", refresh: "rt-w", access: "at-w", expires: 1_900_000_000_000 } },
						aliases: {},
					},
				},
			}),
			{ mode: 0o600 },
		);
	}
	return dir;
}

interface PiRun {
	exitCode: number;
	events: string[];
}

async function runPiTurn(sandbox: string, extraEnv: Record<string, string>): Promise<PiRun> {
	const proc = Bun.spawn(
		["pi", "--mode", "rpc", "-ne", "-e", EXTENSION, "--no-session", "--model", "mockai/mock-1"],
		{
			env: { ...process.env, PI_CODING_AGENT_DIR: sandbox, ...extraEnv },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	proc.stdin.write(`${JSON.stringify({ type: "prompt", message: "hi" })}\n`);
	proc.stdin.flush();

	const events: string[] = [];
	const decoder = new TextDecoder();
	let buffered = "";
	const deadline = Date.now() + 45_000;
	const reader = proc.stdout.getReader();
	settled: while (Date.now() < deadline) {
		const chunk = await Promise.race([
			reader.read(),
			Bun.sleep(Math.max(1, deadline - Date.now())).then(() => undefined),
		]);
		if (chunk === undefined || chunk.done) break;
		buffered += decoder.decode(chunk.value);
		let newline = buffered.indexOf("\n");
		while (newline !== -1) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			if (line.trim().length > 0) events.push(line);
			try {
				const parsed = JSON.parse(line) as { type?: string };
				if (parsed.type === "agent_settled" || parsed.type === "agent_end") break settled;
			} catch {
				// non-JSON noise
			}
			newline = buffered.indexOf("\n");
		}
	}
	reader.releaseLock();
	proc.stdin.end();
	const exitCode = await proc.exited;
	return { exitCode, events };
}

describe("AC-008 at runner level (T038)", () => {
	test(
		"control: with nothing to abort, the runner reaches the provider (spy counts)",
		async () => {
			const sandbox = makeSandbox(false);
			try {
				providerHits = 0;
				await runPiTurn(sandbox, {});
				expect(providerHits).toBeGreaterThanOrEqual(1); // the spy demonstrably counts real streams
			} finally {
				rmSync(sandbox, { recursive: true, force: true });
			}
		},
		60_000,
	);

	test(
		"turn_start abort → zero provider stream calls in the real runner",
		async () => {
			const sandbox = makeSandbox(true);
			try {
				providerHits = 0;
				const run = await runPiTurn(sandbox, { PI_SEAT: "nosuch" }); // AC-004 startup fail-closed
				expect(providerHits).toBe(0); // pi's own loop never streamed
				// The abort surfaced to the RPC client rather than silently stalling.
				expect(run.events.some((line) => line.includes("PI_SEAT") || line.includes("abort"))).toBe(true);
			} finally {
				rmSync(sandbox, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
