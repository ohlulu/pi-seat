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

let authFileCounter = 0;

function makeCli(
	options: {
		piSeat?: string;
		confirmAnswer?: boolean;
		claude?: string;
		empty?: boolean;
		codexDefault?: string;
		auth?: Record<string, unknown>;
	} = {},
): Cli {
	const backend = new InMemorySeatStorageBackend();
	if (!options.empty) {
		const store = emptyStore();
		store.providers.anthropic = {
			default: "work",
			profiles: Object.assign(Object.create(null), { work: cred("rt-w"), personal: cred("rt-p") }),
			aliases: Object.assign(Object.create(null), { p: "personal" }),
		};
		store.providers["openai-codex"] = {
			...(options.codexDefault !== undefined ? { default: options.codexDefault } : {}),
			profiles: Object.assign(Object.create(null), { main: cred("rt-c"), backup: cred("rt-cb") }),
			aliases: Object.assign(Object.create(null)),
		};
		backend.withLock(() => ({ result: undefined, next: encodeStore(store) }));
	}
	let testAuthPath = authPath;
	if (options.auth !== undefined) {
		authFileCounter += 1;
		testAuthPath = join(fixtureDir, `auth-${authFileCounter}.json`);
		writeFileSync(testAuthPath, JSON.stringify(options.auth), { mode: 0o600 });
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
		authPath: testAuthPath,
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

	test("AC-022: each provider gets a section header, and its active account leads the section", async () => {
		// Store order is work, personal for anthropic and main, backup for codex;
		// the pin and the codex default must each be hoisted to the top of their
		// own section without disturbing the other provider's block.
		const cli = makeCli({ piSeat: "p", codexDefault: "backup" }); // alias p → personal
		expect(await cli.run()).toBe(0);

		const at = (needle: string) => cli.out.findIndex((l) => l.startsWith(needle));
		expect(at("ANTHROPIC · personal (pin)")).toBeGreaterThanOrEqual(0);
		expect(at("OPENAI-CODEX · backup (default)")).toBeGreaterThan(at("ANTHROPIC · personal (pin)"));
		expect(at("● personal")).toBeLessThan(at("○ work"));
		expect(at("○ work")).toBeLessThan(at("OPENAI-CODEX"));
		expect(at("● backup")).toBeLessThan(at("○ main"));
		// A rule under each header, inside the width-1 budget.
		expect(cli.out).toContain("─".repeat(79));
		// --json is a machine contract: no chrome on stdout.
		const json = makeCli({ piSeat: "p" });
		expect(await json.run("usage", "--json")).toBe(0);
		expect(json.out.join("\n")).not.toContain("ANTHROPIC");
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

	test("T046: the pin, the selection and the account list come from ONE snapshot", async () => {
		const cli = makeCli({ piSeat: "p" }); // alias p → personal
		// A rename lands the instant the CLI has read the store. Reading again for
		// the enumeration would describe a store the selection never saw: the
		// report would say nothing is active while quietly fetching "other".
		const realRead = cli.backend.read.bind(cli.backend);
		let reads = 0;
		(cli.backend as { read: unknown }).read = <T,>(fn: (current: string | undefined) => T): T => {
			const result = realRead(fn);
			if ((reads += 1) === 1) {
				cli.backend.withLock((current) => {
					const store = decodeStore(current!);
					const section = store.providers.anthropic!;
					section.profiles["other"] = section.profiles["personal"]!;
					delete section.profiles["personal"];
					delete section.aliases["p"];
					return { result: undefined, next: encodeStore(store) };
				});
			}
			return result;
		};

		expect(await cli.run("usage", "--json")).toBe(1); // personal vanished mid-run
		const doc = JSON.parse(cli.out.join("\n")) as Record<string, any>;
		expect(doc["anthropic"].active).toBe("personal"); // the label the pin named
		expect(cli.out.join("\n")).not.toContain("other"); // never enumerated, never fetched
		expect(cli.errs.some((l) => l.includes("personal") && l.includes("unavailable"))).toBe(true);
	});

	test("T047: a finished account prints before a slow one answers", async () => {
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const cli = makeCli();
		cli.deps.fetchOptions = {
			fetchImpl: (async () => {
				if ((calls += 1) === 2) await blocked; // the second account stalls
				return Response.json(CLAUDE_PAYLOAD);
			}) as unknown as typeof fetch,
		};

		const running = cli.run();
		for (let i = 0; i < 10 && cli.out.length === 0; i += 1) await new Promise((r) => setTimeout(r, 1));
		// The first account's bars are on stdout while the second is still in
		// flight — a 10s timeout downstream must not hold back what already landed.
		expect(cli.out.join("\n")).toContain("● work");
		expect(cli.out.join("\n")).not.toContain("personal");

		release?.();
		expect(await running).toBe(0);
		expect(cli.out.join("\n")).toContain("personal");
	});

	test("T037: refresh errors echoing credentials never reach stderr unredacted", async () => {
		const cli = makeCli();
		// Expire a profile and make its refresh throw with the tokens embedded.
		cli.backend.withLock((current) => {
			const store = decodeStore(current!);
			store.providers.anthropic!.profiles["work"] = { type: "oauth", refresh: "rt-leaky", access: "at-leaky", expires: Date.now() - 60_000 };
			return { result: undefined, next: encodeStore(store) };
		});
		for (const adapter of cli.deps.adapters) {
			adapter.oauth.refresh = async (c) => {
				throw new Error(`refresh ${(c as SeatCredential).refresh} rejected (access ${(c as SeatCredential).access})`);
			};
		}
		expect(await cli.run("usage", "--json")).toBe(1);
		const everything = [...cli.out, ...cli.errs].join("\n");
		expect(everything).not.toContain("rt-leaky");
		expect(everything).not.toContain("at-leaky");
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

	test("AC-017: `-a` attaches an alias while switching, via `use` and via shorthand", async () => {
		const cli = makeCli();
		expect(await cli.run("use", "personal", "-a", "o")).toBe(0);
		let store = cli.backend.read((c) => decodeStore(c));
		expect(store.providers.anthropic?.default).toBe("personal");
		expect(store.providers.anthropic?.aliases["o"]).toBe("personal");
		expect(cli.out).toEqual([]); // still nothing on stdout

		// The fresh alias resolves on the next invocation.
		expect(await cli.run("o")).toBe(0);
		expect(storedDefault(cli)).toBe("personal");

		// Shorthand takes repeatable --alias too.
		expect(await cli.run("work", "-a", "w", "--alias", "day")).toBe(0);
		store = cli.backend.read((c) => decodeStore(c));
		expect(store.providers.anthropic?.default).toBe("work");
		expect(store.providers.anthropic?.aliases["w"]).toBe("work");
		expect(store.providers.anthropic?.aliases["day"]).toBe("work");
	});

	test("AC-017: bad alias arguments — invocation errors exit 2, conflicts exit 1", async () => {
		const cli = makeCli();
		expect(await cli.run("use", "work", "-a")).toBe(2); // missing value
		expect(await cli.run("use", "work", "--wat", "x")).toBe(2); // unknown flag
		expect(await cli.run("use", "work", "extra")).toBe(2); // second positional
		expect(await cli.run("use", "work", "-a", "p")).toBe(1); // alias owned by personal
		expect(await cli.run("use", "work", "-a", "a:b")).toBe(1); // charset rule
		const store = cli.backend.read((c) => decodeStore(c));
		expect(store.providers.anthropic?.aliases["p"]).toBe("personal"); // untouched
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

	test("T036 regression: grant replaced during the confirm wait is not deleted unseen", async () => {
		const cli = makeCli();
		let confirmCount = 0;
		cli.deps.io.confirm = async (question) => {
			cli.confirms.push(question);
			confirmCount += 1;
			if (confirmCount === 1) {
				// While the user stares at the prompt, a login replaces the grant.
				cli.backend.withLock((current) => {
					const store = decodeStore(current!);
					store.providers.anthropic!.profiles["work"] = cred("rt-replaced");
					return { result: undefined, next: encodeStore(store) };
				});
			}
			return true;
		};
		expect(await cli.run("rm", "work")).toBe(0);
		// The first confirmation covered the OLD grant; deleting the replaced one
		// requires a second look. Only then may the profile go.
		expect(confirmCount).toBe(2);
		expect(cli.backend.read((c) => decodeStore(c)).providers.anthropic?.profiles["work"]).toBeUndefined();
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

describe("T039: codex usage renders every stored profile plus the builtin snapshot", () => {
	test("named codex selection no longer hides the other profiles or the builtin", async () => {
		const cli = makeCli({
			codexDefault: "main", // named selection exists — the buggy path skipped builtin
			auth: { "openai-codex": { type: "oauth", refresh: "rt-builtin-c", access: "at-builtin-c", expires: FRESH } },
		});
		expect(await cli.run("usage", "--json")).toBe(0);
		const doc = JSON.parse(cli.out.join("\n")) as Record<string, any>;
		expect(doc["openai-codex"].active).toBe("main");
		expect(Object.keys(doc["openai-codex"].profiles).sort()).toEqual(["backup", "main"]); // every stored profile
		expect(doc["openai-codex-builtin"]).toBeDefined(); // builtin rendered independently

		cli.out.length = 0;
		expect(await cli.run()).toBe(0);
		const text = cli.out.join("\n");
		expect(text).toContain("● main"); // effective named profile is live
		expect(text).toContain("○ backup"); // dormant codex profile visible
		expect(text).toContain("Codex"); // builtin block visible
	});

	test("no codex profiles: builtin keeps the legacy top-level shape", async () => {
		const cli = makeCli({
			empty: true,
			auth: { "openai-codex": { type: "oauth", refresh: "rt-only-c", access: "at-only-c", expires: FRESH } },
		});
		expect(await cli.run("usage", "--json")).toBe(0);
		const doc = JSON.parse(cli.out.join("\n")) as Record<string, any>;
		expect(doc["openai-codex"].rate_limit).toBeDefined(); // legacy: usage sits directly under the provider key
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
