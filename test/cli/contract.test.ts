import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";
import { InMemorySeatStorageBackend, decodeStore, encodeStore } from "../../src/store/storage.ts";
import type { SeatProviderAdapter } from "../../src/extension/oauth.ts";
import { runCli, type CliDeps } from "../../src/cli/main.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FRESH = Date.now() + 3_600_000;

const CLAUDE_PAYLOAD = { limits: [{ kind: "session", percent: 42, resets_at: new Date(FRESH).toISOString() }] };
const CODEX_PAYLOAD = { plan_type: "plus", rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 37 } } };

let server: ReturnType<typeof Bun.serve>;
let claudeUrl: string;
let codexUrl: string;
let boomUrl: string;
let fixtureDir: string;
let authPath: string;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const path = new URL(req.url).pathname;
			if (path === "/claude") return Response.json(CLAUDE_PAYLOAD);
			if (path === "/codex") return Response.json(CODEX_PAYLOAD);
			return new Response("boom", { status: 500 });
		},
	});
	claudeUrl = `http://localhost:${server.port}/claude`;
	codexUrl = `http://localhost:${server.port}/codex`;
	boomUrl = `http://localhost:${server.port}/boom`;
	fixtureDir = mkdtempSync(join(tmpdir(), "seat-cli-"));
	authPath = join(fixtureDir, "auth.json");
	writeFileSync(authPath, JSON.stringify({}), { mode: 0o600 });
});

afterAll(() => {
	server.stop(true);
	rmSync(fixtureDir, { recursive: true, force: true });
});

function cred(refresh: string): SeatCredential {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires: FRESH };
}

interface Cli {
	deps: CliDeps;
	backend: InMemorySeatStorageBackend;
	out: string[];
	errs: string[];
	confirms: string[];
	run(...argv: string[]): Promise<number>;
}

function makeCli(options: { piSeat?: string; confirmAnswer?: boolean; claude?: string; empty?: boolean } = {}): Cli {
	const backend = new InMemorySeatStorageBackend();
	if (!options.empty) {
		const store = emptyStore();
		store.providers.anthropic = {
			default: "work",
			profiles: Object.assign(Object.create(null), { work: cred("rt-w"), personal: cred("rt-p") }),
			aliases: Object.assign(Object.create(null), { p: "personal" }),
		};
		store.providers["openai-codex"] = {
			profiles: Object.assign(Object.create(null), { main: cred("rt-c") }),
			aliases: Object.assign(Object.create(null)),
		};
		backend.withLock(() => ({ result: undefined, next: encodeStore(store) }));
	}

	const adapters: SeatProviderAdapter[] = (["anthropic", "openai-codex"] as const).map((id) => ({
		id,
		displayName: id,
		oauth: {
			login: async () => cred(`rt-minted-${id}`) as never,
			refresh: async (c) => c,
			toAuth: async (c) => ({ apiKey: (c as SeatCredential).access }) as never,
		},
	}));

	const cli: Cli = {
		backend,
		out: [],
		errs: [],
		confirms: [],
		deps: undefined as never,
		run: (...argv) => runCli(argv, cli.deps),
	};
	cli.deps = {
		backend,
		adapters,
		authPath,
		env: options.piSeat !== undefined ? { PI_SEAT: options.piSeat } : {},
		io: {
			out: (line) => cli.out.push(line),
			err: (line) => cli.errs.push(line),
			confirm: async (question) => {
				cli.confirms.push(question);
				return options.confirmAnswer ?? true;
			},
			input: async () => undefined,
		},
		termWidth: 80,
		color: false,
		fetchOptions: { claudeUrl: options.claude ?? claudeUrl, codexUrl },
	};
	return cli;
}

function storedDefault(cli: Cli): string | undefined {
	return cli.backend.read((c) => decodeStore(c)).providers.anthropic?.default;
}

describe("usage", () => {
	test("legacy `seat usage --json`: valid JSON on stdout, exit 0", async () => {
		const cli = makeCli();
		expect(await cli.run("usage", "--json")).toBe(0);
		const doc = JSON.parse(cli.out.join("\n")) as Record<string, any>;
		expect(doc["anthropic"].active).toBe("work");
		expect(Object.keys(doc["anthropic"].profiles).sort()).toEqual(["personal", "work"]);
		expect(doc["anthropic"].profiles.work.limits[0].percent).toBe(42);
	});

	test("bare `seat` renders meter blocks on stdout", async () => {
		const cli = makeCli();
		expect(await cli.run()).toBe(0);
		const text = cli.out.join("\n");
		expect(text).toContain("● work");
		expect(text).toContain("○ personal (p)");
		expect(text).toContain("42%");
		expect(text).toContain("█");
	});

	test("endpoint failure → exit 1, diagnostics for --json go to stderr", async () => {
		const cli = makeCli({ claude: boomUrl });
		expect(await cli.run("usage", "--json")).toBe(1);
		expect(cli.errs.some((l) => l.includes("unavailable"))).toBe(true);
		expect(() => JSON.parse(cli.out.join("\n"))).not.toThrow(); // stdout stays parseable
	});

	test("unknown usage flag → exit 2", async () => {
		expect(await makeCli().run("usage", "--bogus")).toBe(2);
	});
});

describe("mutations via CLI", () => {
	test("`seat use <alias>` and bare shorthand both persist the default", async () => {
		const cli = makeCli();
		expect(await cli.run("use", "p")).toBe(0);
		expect(storedDefault(cli)).toBe("personal");
		expect(await cli.run("work")).toBe(0); // shorthand
		expect(storedDefault(cli)).toBe("work");
		expect(cli.out).toEqual([]); // mutations put nothing on stdout
	});

	test("`seat login` mints through the adapter and stores", async () => {
		const cli = makeCli();
		expect(await cli.run("login", "openai-codex:backup", "-a", "b")).toBe(0);
		const store = cli.backend.read((c) => decodeStore(c));
		expect(store.providers["openai-codex"]?.profiles["backup"]?.refresh).toBe("rt-minted-openai-codex");
		expect(store.providers["openai-codex"]?.aliases["b"]).toBe("backup");
	});

	test("`seat rm` alias vs profile; declined confirm → exit 1", async () => {
		const declined = makeCli({ confirmAnswer: false });
		expect(await declined.run("rm", "work")).toBe(1);
		expect(declined.confirms).toHaveLength(1);
		expect(storedDefault(declined)).toBe("work"); // untouched

		const cli = makeCli();
		expect(await cli.run("rm", "p")).toBe(0); // alias: no confirm
		expect(cli.confirms).toHaveLength(0);
		expect(await cli.run("rm", "personal", "--force")).toBe(0);
		expect(cli.backend.read((c) => decodeStore(c)).providers.anthropic?.profiles["personal"]).toBeUndefined();
	});

	test("rm --no-input on a profile fails instead of prompting", async () => {
		const cli = makeCli();
		expect(await cli.run("rm", "work", "--no-input")).toBe(1);
		expect(cli.confirms).toHaveLength(0);
	});

	test("`seat rename` retargets; `seat whoami` reports default and pin", async () => {
		const cli = makeCli({ piSeat: "personal" });
		expect(await cli.run("rename", "work", "day")).toBe(0);
		expect(await cli.run("whoami")).toBe(0);
		expect(cli.out).toContain("anthropic: default=day pin=personal");
		cli.out.length = 0;
		expect(await cli.run("whoami", "--plain")).toBe(0);
		expect(cli.out).toEqual(["anthropic\tday\tpersonal", "openai-codex\t-\t-"]);
	});

	test("operation failures exit 1; bad invocations exit 2", async () => {
		const cli = makeCli();
		expect(await cli.run("use", "nosuch")).toBe(1);
		expect(await cli.run("rm", "nosuch")).toBe(1);
		expect(await cli.run("rename", "nosuch", "x")).toBe(1);
		expect(await cli.run("use")).toBe(2);
		expect(await cli.run("rename", "only-one")).toBe(2);
		expect(await cli.run("rm")).toBe(2);
		expect(await cli.run("rm", "x", "--wat")).toBe(2);
		expect(await cli.run("--wat")).toBe(2);
		expect(await cli.run("status", "--wat")).toBe(2);
	});
});

describe("status --plain contract", () => {
	test("four tab-separated columns, no header; default marks active", async () => {
		const cli = makeCli();
		expect(await cli.run("status", "--plain")).toBe(0);
		expect(cli.out).toHaveLength(2); // anthropic-only: work + personal, no codex rows
		for (const row of cli.out) expect(row.split("\t")).toHaveLength(4);
		const work = cli.out.find((r) => r.startsWith("work\t"))!;
		expect(work.split("\t")[1]).toBe("active");
		expect(work.split("\t")[2]).toBe(String(FRESH));
		const personal = cli.out.find((r) => r.startsWith("personal\t"))!;
		expect(personal.split("\t")[1]).toBe("-");
		expect(personal.split("\t")[3]).toBe("p");
	});

	test("pin-active semantics: pin outranks default", async () => {
		const cli = makeCli({ piSeat: "personal" });
		expect(await cli.run("status", "--plain")).toBe(0);
		expect(cli.out.find((r) => r.startsWith("personal\t"))!.split("\t")[1]).toBe("active");
		expect(cli.out.find((r) => r.startsWith("work\t"))!.split("\t")[1]).toBe("-");
	});

	test("no active row under built-in login", async () => {
		const cli = makeCli();
		await cli.run("use", "default"); // clear the default
		cli.out.length = 0;
		expect(await cli.run("status", "--plain")).toBe(0);
		for (const row of cli.out) expect(row.split("\t")[1]).toBe("-");
	});

	test("invalid PI_SEAT degrades to no pin with a stderr diagnostic", async () => {
		const cli = makeCli({ piSeat: "nosuch" });
		expect(await cli.run("status", "--plain")).toBe(0);
		expect(cli.out.find((r) => r.startsWith("work\t"))!.split("\t")[1]).toBe("active"); // default still applies
		expect(cli.errs.some((l) => l.includes("PI_SEAT"))).toBe(true);
	});
});

describe("stream separation", () => {
	test("prompts and diagnostics never land on stdout", async () => {
		const cli = makeCli();
		await cli.run("use", "p");
		await cli.run("rm", "work"); // confirm prompt via io.confirm (stderr channel)
		await cli.run("use", "nosuch");
		await cli.run("--wat");
		expect(cli.out).toEqual([]); // every mutation/diagnostic line went to stderr
		expect(cli.errs.length).toBeGreaterThan(0);
	});

	test("help and version are primary output (stdout)", async () => {
		const cli = makeCli();
		expect(await cli.run("--help")).toBe(0);
		expect(await cli.run("--version")).toBe(0);
		expect(cli.out.join("\n")).toContain("seat use <selector>");
		expect(cli.out.join("\n")).toContain("seat 3");
		expect(cli.errs).toEqual([]);
	});
});
