/**
 * REQ-010 / AC-018: the in-session usage view.
 *
 * The component is driven without a terminal — `render(width)` and
 * `handleInput(data)` are called directly, exactly as pi.md's render-probe
 * pattern prescribes. The width sweep measures with pi-tui's REAL
 * `visibleWidth`, because that is the function Pi's differential renderer uses
 * before it throws "Rendered line N exceeds terminal width" from its own loop,
 * where no try/catch of ours can reach it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStore, type SeatOAuthCredential } from "../../src/store/schema.ts";
import { InMemorySeatStorageBackend, decodeStore, encodeStore } from "../../src/store/storage.ts";
import type { RefreshCallback } from "../../src/store/refresh.ts";
import { createStoreSchedule } from "../../src/store/scheduler.ts";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "../../src/usage/render.ts";
import {
	IDLE_TICK_MS,
	LOADING_TEXT,
	MARK_SELECTED,
	UsageView,
	VIEW_LEGEND,
	VIEW_TITLE,
	isCloseKey,
	isDownKey,
	isEnterKey,
	isResetKey,
	isUpKey,
	RESET_CONFIRM_LEGEND,
	type UsageViewDeps,
} from "../../src/extension/usage-view.ts";
import { CODEX_RESET_CONSUME_URL, CODEX_RESET_CREDITS_URL } from "../../src/usage/resets.ts";

const FRESH = Date.UTC(2026, 0, 15, 12, 0, 0) + 3_600_000;
const NOW = () => new Date(Date.UTC(2026, 0, 15, 12, 0, 0));

const CLAUDE_PAYLOAD = {
	limits: [
		{ kind: "session", percent: 42, resets_at: "2026-01-15T14:31:00+00:00" },
		{ kind: "opus", group: "weekly", scope: { model: { display_name: "Opus" } }, percent: 91, resets_at: "2026-01-20T14:31:00+00:00" },
	],
};
const CODEX_PAYLOAD = {
	plan_type: "plus",
	rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 37, reset_at: 1_768_486_320 } },
};

let server: ReturnType<typeof Bun.serve>;
let claudeUrl: string;
let codexUrl: string;
let fixtureDir: string;
let authPath: string;
let emptyAuthPath: string;

/** Every usage request the fixture server has answered. Enter must not add
 * any: liveness is a store fact, not a metered one. */
let fetches = 0;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const path = new URL(req.url).pathname;
			fetches += 1;
			if (path === "/claude") return Response.json(CLAUDE_PAYLOAD);
			if (path === "/codex") return Response.json(CODEX_PAYLOAD);
			return new Response("boom", { status: 500 });
		},
	});
	claudeUrl = `http://localhost:${server.port}/claude`;
	codexUrl = `http://localhost:${server.port}/codex`;
	fixtureDir = mkdtempSync(join(tmpdir(), "seat-view-"));
	authPath = join(fixtureDir, "auth.json");
	emptyAuthPath = join(fixtureDir, "auth-empty.json");
	writeFileSync(authPath, JSON.stringify({ anthropic: { type: "oauth", refresh: "rt-builtin", access: "at-builtin", expires: FRESH } }), { mode: 0o600 });
	writeFileSync(emptyAuthPath, JSON.stringify({}), { mode: 0o600 });
});

afterAll(() => {
	server.stop(true);
	rmSync(fixtureDir, { recursive: true, force: true });
});

function cred(refresh: string, expires = FRESH): SeatOAuthCredential {
	return { type: "oauth", refresh, access: `at-${refresh}`, expires };
}

interface Harness {
	view: UsageView;
	renders: number;
	closed: number;
	backend: InMemorySeatStorageBackend;
	refreshCalls: string[];
	timers: { fn: () => void; ms: number; cleared: boolean }[];
	cleared: number;
	clock: { ms: number };
	settle(): Promise<void>;
}

function makeView(
	options: {
		profiles?: Record<string, SeatOAuthCredential>;
		aliases?: Record<string, string>;
		default?: string;
		pins?: Record<string, string>;
		auth?: string;
		codexUrl?: string;
		claudeUrl?: string;
		color?: boolean;
		clock?: { ms: number };
		/** Routes REQ-012's reset endpoints; usage requests still reach the fixture server. */
		fetchImpl?: typeof fetch;
	} = {},
): Harness {
	const backend = new InMemorySeatStorageBackend();
	const store = emptyStore();
	store.providers.anthropic = {
		...(options.default !== undefined ? { default: options.default } : { default: "work" }),
		profiles: Object.assign(Object.create(null), options.profiles ?? { work: cred("rt-w"), personal: cred("rt-p") }),
		aliases: Object.assign(Object.create(null), options.aliases ?? { w: "work" }),
	};
	backend.withLock(() => ({ result: undefined, next: encodeStore(store) }));

	const refreshCalls: string[] = [];
	const refresh: RefreshCallback = async (credential) => {
		refreshCalls.push(credential.refresh);
		return { ...credential, access: `${credential.access}-rotated`, expires: FRESH };
	};

	const harness: Harness = {
		view: undefined as never,
		renders: 0,
		closed: 0,
		backend,
		refreshCalls,
		timers: [],
		cleared: 0,
		clock: options.clock ?? { ms: NOW().getTime() },
		settle: async () => {
			// Two macrotask hops: collectUsage awaits fetch per account.
			for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 1));
		},
	};

	const deps: UsageViewDeps = {
		backend,
		schedule: createStoreSchedule(),
		authPath: options.auth ?? emptyAuthPath,
		pins: (options.pins ?? {}) as UsageViewDeps["pins"],
		refreshFor: () => refresh,
		fetchOptions: {
			claudeUrl: options.claudeUrl ?? claudeUrl,
			codexUrl: options.codexUrl ?? codexUrl,
			now: () => harness.clock.ms,
			...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
		},
		resetRequestId: () => "req-view-1",
		color: options.color ?? false,
		now: () => new Date(harness.clock.ms),
		timeZone: "UTC",
		setInterval: (fn, ms) => {
			harness.timers.push({ fn, ms, cleared: false });
			return harness.timers.length - 1;
		},
		clearInterval: (handle) => {
			harness.cleared += 1;
			const timer = harness.timers[handle as number];
			if (timer) timer.cleared = true;
		},
	};

	harness.view = new UsageView(deps, {
		onChange: () => {
			harness.renders += 1;
		},
		onClose: () => {
			harness.closed += 1;
		},
	});
	return harness;
}

describe("AC-018: the view renders the meters plus default/pin state", () => {
	test("section headers name the effective selection; every stored profile gets a bar block", async () => {
		const h = makeView({ pins: { anthropic: "personal" }, auth: authPath });
		h.view.start();
		await h.settle();

		const lines = h.view.render(100);
		expect(lines[0]).toContain(VIEW_TITLE);
		// AC-022: default/pin state sits in each provider's section header, in the
		// same words `seat status` uses.
		expect(lines).toContain("ANTHROPIC · personal (pin)");
		expect(lines).toContain("OPENAI-CODEX · Pi built-in login");

		const text = lines.join("\n");
		expect(text).toContain("work");
		expect(text).toContain("personal");
		expect(text).toContain("Claude"); // the built-in snapshot block
		expect(text).toContain("█"); // bars actually rendered
		expect(text).toContain("42%");
		// The pinned account is the live one; the dot precedes its name, behind the
		// selection gutter every account row now carries.
		expect(lines.some((l) => l.endsWith("● personal"))).toBe(true);
		expect(lines.some((l) => l.endsWith("○ work (w)"))).toBe(true);
		expect(lines.at(-1)).toContain(VIEW_LEGEND);
	});

	test("AC-022: the live account leads its section, and a provider with nothing to meter still gets a header", async () => {
		// `work` is stored first but `personal` is the pin, so the pin must be the
		// first account row under the anthropic header.
		const h = makeView({ pins: { anthropic: "personal" }, auth: emptyAuthPath });
		h.view.start();
		await h.settle();

		const lines = h.view.render(100);
		const header = lines.indexOf("ANTHROPIC · personal (pin)");
		expect(header).toBeGreaterThanOrEqual(0);
		expect(lines.findIndex((l) => l.includes("● personal"))).toBeLessThan(
			lines.findIndex((l) => l.includes("○ work")),
		);
		// The rule spans the block and stops inside the width budget.
		expect(lines[header + 1]).toBe("─".repeat(99));
		// No codex profile and no codex credential in auth.json: the section still
		// reports what that provider is using.
		expect(lines).toContain("OPENAI-CODEX · Pi built-in login");
	});

	test("a spinner row shows until the fetches land, then goes away", async () => {
		const h = makeView();
		h.view.start();
		const loading = h.view.render(80);
		expect(loading.join("\n")).toContain(LOADING_TEXT);
		expect(loading.some((l) => l.includes(SPINNER_FRAMES[0]!))).toBe(true);

		// The spinner is an interval, and it advances frames.
		expect(h.timers).toHaveLength(1);
		h.timers[0]!.fn();
		expect(h.view.render(80).some((l) => l.includes(SPINNER_FRAMES[1]!))).toBe(true);

		await h.settle();
		expect(h.view.render(80).join("\n")).not.toContain(LOADING_TEXT);
	});

	test("an unavailable account is annotated inline, never fatal", async () => {
		const h = makeView({ claudeUrl: `${claudeUrl.replace("/claude", "/boom")}` });
		h.view.start();
		await h.settle();
		const text = h.view.render(80).join("\n");
		expect(text).toContain("unavailable");
		expect(text).toContain("HTTP 500");
		expect(text).toContain(VIEW_LEGEND); // the view still stands
	});
});

const marked = (lines: string[]): string[] => lines.filter((l) => l.startsWith(MARK_SELECTED));

describe("AC-023: arrow-key selection and enter-to-switch", () => {
	const nameOf = (line: string): string => line.slice(MARK_SELECTED.length).trim();

	test("the cursor starts on the live account and moves with ↑↓ / jk, clamped at both ends", async () => {
		// Store order is work, personal; `personal` is the default, so the walk
		// puts it first and the cursor is on it without the user doing anything.
		const h = makeView({ default: "personal", auth: authPath });
		h.view.start();
		await h.settle();

		expect(nameOf(marked(h.view.render(100))[0]!)).toBe("● personal");
		// The marker covers the WHOLE block, not just its header row.
		expect(marked(h.view.render(100))).toHaveLength(3); // header + two meters

		h.view.handleInput("\x1b[B");
		expect(nameOf(marked(h.view.render(100))[0]!)).toBe("○ work (w)");
		h.view.handleInput("j");
		expect(nameOf(marked(h.view.render(100))[0]!)).toBe("○ Claude · built-in");
		h.view.handleInput("\x1bOB"); // application cursor mode, last account
		expect(nameOf(marked(h.view.render(100))[0]!)).toBe("○ Claude · built-in");

		h.view.handleInput("k");
		h.view.handleInput("\x1b[A");
		h.view.handleInput("\x1bOA"); // clamps at the top
		expect(nameOf(marked(h.view.render(100))[0]!)).toBe("● personal");
	});

	test("enter switches the default and moves the dot without refetching", async () => {
		const h = makeView({ default: "personal", auth: emptyAuthPath });
		h.view.start();
		await h.settle();
		const before = fetches;

		h.view.handleInput("\x1b[B"); // onto `work`
		h.view.handleInput("\r");
		await h.settle();

		const lines = h.view.render(100);
		expect(lines.some((l) => l.includes("● work (w)"))).toBe(true);
		expect(lines.some((l) => l.includes("○ personal"))).toBe(true);
		expect(lines).toContain(`ANTHROPIC · work (default)`); // the header follows too
		expect(lines.join("\n")).toContain('anthropic default is now "work"');
		// The store is what changed; the meters on screen are still valid.
		expect(fetches).toBe(before);
		expect(h.backend.read((c) => decodeStore(c)).providers.anthropic?.default).toBe("work");
		// The block stays where the cursor put it — re-sorting under the cursor is
		// exactly what the walk order must not do mid-session.
		expect(nameOf(marked(lines)[0]!)).toBe("● work (w)");
	});

	test("AC-016 in the view: a pinned session writes the default, keeps the pin, and says so", async () => {
		const h = makeView({ pins: { anthropic: "personal" }, auth: emptyAuthPath });
		h.view.start();
		await h.settle();

		h.view.handleInput("\x1b[B"); // onto `work`
		h.view.handleInput("\r");
		await h.settle();

		const lines = h.view.render(100);
		expect(h.backend.read((c) => decodeStore(c)).providers.anthropic?.default).toBe("work");
		// The pin is immutable for the session (DEC-002), so the dot CANNOT move.
		// Without the notice the view would look broken in exactly the sessions
		// multi-account management matters most.
		expect(lines.some((l) => l.includes("● personal"))).toBe(true);
		expect(lines.some((l) => l.includes("○ work (w)"))).toBe(true);
		expect(lines).toContain("ANTHROPIC · personal (pin)");
		expect(lines.join("\n")).toContain('anthropic default is now "work" — this session keeps its pin (personal)');
	});

	test("enter on the built-in row clears that provider's default", async () => {
		const h = makeView({ default: "work", profiles: { work: cred("rt-w") }, aliases: {}, auth: authPath });
		h.view.start();
		await h.settle();

		h.view.handleInput("\x1b[B"); // onto the Claude built-in row
		expect(nameOf(marked(h.view.render(100))[0]!)).toBe("○ Claude · built-in");
		h.view.handleInput("\r");
		await h.settle();

		const lines = h.view.render(100);
		expect(h.backend.read((c) => decodeStore(c)).providers.anthropic?.default).toBeUndefined();
		expect(lines).toContain("ANTHROPIC · Pi built-in login");
		expect(lines.some((l) => l.includes("● Claude"))).toBe(true);
		expect(lines.join("\n")).toContain("anthropic default cleared; Pi built-in login applies");
	});

	test("keys are recognized in CSI-u form too — Pi negotiates the Kitty protocol", async () => {
		// Pi asks for Kitty keyboard flags 1|2|4 at startup, so on Kitty / Ghostty /
		// WezTerm esc arrives as `esc [ 27 u` and enter as `esc [ 13 u`. tmux does
		// not negotiate it, so the TUI smoke is green either way and cannot catch
		// this: only matching through pi-tui's matchesKey covers both encodings.
		for (const active of [false, true]) {
			setKittyProtocolActive(active);
			try {
				expect(isUpKey("\x1b[A")).toBe(true);
				expect(isUpKey("\x1b[1;1A")).toBe(true);
				expect(isDownKey("\x1b[B")).toBe(true);
				expect(isEnterKey("\r")).toBe(true);
				expect(isEnterKey("\x1b[13u")).toBe(true);
				expect(isCloseKey("\x1b")).toBe(true);
				expect(isCloseKey("\x1b[27u")).toBe(true);
				expect(isCloseKey("q")).toBe(true);
				// An arrow is still not a close, in either encoding.
				expect(isCloseKey("\x1b[A")).toBe(false);
				expect(isCloseKey("\x1b[1;1A")).toBe(false);
				expect(isUpKey("\x1b")).toBe(false);
				expect(isEnterKey("\x1b[27u")).toBe(false);
			} finally {
				setKittyProtocolActive(false);
			}
		}
		// A live view still closes on the CSI-u escape.
		setKittyProtocolActive(true);
		try {
			const h = makeView({ auth: emptyAuthPath });
			h.view.start();
			await h.settle();
			h.view.handleInput("\x1b[13u"); // enter: switches, does not close
			expect(h.closed).toBe(0);
			h.view.handleInput("\x1b[27u");
			expect(h.closed).toBe(1);
		} finally {
			setKittyProtocolActive(false);
		}
	});

	test("a walk that throws part-way still leaves the cursor inside the list", async () => {
		// readForeignFileNoFollow throws on a non-regular auth.json, and it runs
		// OUTSIDE builtinUsage's try — so collectUsage propagates after the stored
		// profiles have already streamed in. A cursor left past the survivors shows
		// no marker and makes enter a silent no-op.
		const symlinkAuth = join(fixtureDir, "auth-symlink.json");
		rmSync(symlinkAuth, { force: true });
		symlinkSync(authPath, symlinkAuth);

		const h = makeView({ auth: authPath });
		h.view.start();
		await h.settle();
		h.view.handleInput("\x1b[B");
		h.view.handleInput("\x1b[B"); // onto the built-in row, the last account
		expect(marked(h.view.render(100))[0]).toContain("Claude");

		(h.view as unknown as { deps: { authPath: string } }).deps.authPath = symlinkAuth;
		h.view.handleInput("r");
		await h.settle();

		const lines = h.view.render(100);
		expect(lines.join("\n")).toContain("expected a regular file"); // the walk did throw
		// The built-in row is gone; the cursor is clamped onto a surviving account.
		expect(marked(lines).length).toBeGreaterThan(0);
		expect(marked(lines)[0]).not.toContain("Claude");
	});

	test("the cursor follows its account across a refresh, and keys are inert while loading", async () => {
		const h = makeView({ default: "personal", auth: emptyAuthPath });
		h.view.start();
		// Mid-load: nothing to move over yet, and enter must not mutate the store.
		h.view.handleInput("\x1b[B");
		h.view.handleInput("\r");
		expect(h.backend.read((c) => decodeStore(c)).providers.anthropic?.default).toBe("personal");
		await h.settle();

		h.view.handleInput("\x1b[B"); // onto `work`
		expect(nameOf(marked(h.view.render(100))[0]!)).toBe("○ work (w)");
		h.view.handleInput("r");
		await h.settle();
		expect(nameOf(marked(h.view.render(100))[0]!)).toBe("○ work (w)");
	});
});

describe("AC-018: esc and q close; the spinner is disposed", () => {
	test("both keys close, unrelated keys do not", () => {
		const h = makeView();
		h.view.start();
		h.view.handleInput("x");
		h.view.handleInput("\x1b[A"); // arrow key: an escape SEQUENCE, not esc
		expect(h.closed).toBe(0);
		h.view.handleInput("\x1b");
		expect(h.closed).toBe(1);
		h.view.handleInput("q");
		expect(h.closed).toBe(2);
	});

	test("T048: the 80ms spinner stops once the meters land, and the countdown keeps ticking", async () => {
		const h = makeView();
		h.view.start();
		expect(h.timers[0]!.ms).toBe(SPINNER_INTERVAL_MS);
		await h.settle();

		// Leaving the spinner armed wakes the process 12 times a second to decide
		// it has nothing to draw.
		expect(h.timers[0]!.cleared).toBe(true);
		const idle = h.timers.at(-1)!;
		expect(idle.cleared).toBe(false);
		expect(idle.ms).toBe(IDLE_TICK_MS);

		// The reset countdown is computed at render time, so a cached frame that is
		// never invalidated freezes it at whatever it said when the fetch landed.
		const before = h.view.render(100).join("\n");
		expect(before).toContain("in 2h31m");
		h.clock.ms += 20 * 60_000;
		expect(h.view.render(100).join("\n")).toBe(before); // cache still valid
		idle.fn();
		expect(h.view.render(100).join("\n")).toContain("in 2h11m");

		h.view.dispose();
		expect(h.timers.every((t) => t.cleared)).toBe(true);
	});

	test("dispose clears the interval and silences late results", async () => {
		const h = makeView();
		h.view.start();
		h.view.dispose();
		expect(h.cleared).toBe(1);

		const before = h.renders;
		await h.settle(); // the in-flight collect resolves into a closed view
		expect(h.renders).toBe(before);
	});
});

describe("REQ-010: refresh re-runs the collect through the REQ-005 path", () => {
	test("`r` re-fetches, and an expired profile is refreshed under the store lock", async () => {
		const h = makeView({ profiles: { work: cred("rt-w", Date.UTC(2020, 0, 1)) }, aliases: {}, default: "work" });
		h.view.start();
		await h.settle();
		expect(h.refreshCalls).toEqual(["rt-w"]); // ensureFreshProfile ran

		const rendersBefore = h.renders;
		h.view.handleInput("r");
		await h.settle();
		expect(h.renders).toBeGreaterThan(rendersBefore);
		// The rotated credential was persisted, so the reload finds it fresh.
		expect(h.refreshCalls).toEqual(["rt-w"]);
		expect(h.view.render(80).join("\n")).toContain("42%");
	});
});

describe("render probe: widths 2\u2013200 never overflow", () => {
	// Wide graphemes are the whole point: a pure-ASCII sweep stays green over a
	// CJK-only overflow. The emoji is here because its width is where a
	// hand-rolled cell table and pi-tui are most likely to disagree.
	const WIDE_LABEL = "\u4e2d\u6587\u5e33\u865f\u5f88\u9577\u7684\u540d\u5b57";

	async function loadedView(color: boolean): Promise<Harness> {
		const h = makeView({
			color,
			profiles: {
				[WIDE_LABEL]: cred("rt-cjk"),
				"a-very-long-profile-label-that-runs-past-any-terminal": cred("rt-long"),
			},
			aliases: { [`${WIDE_LABEL}-alias`]: WIDE_LABEL },
			default: WIDE_LABEL,
			auth: authPath,
		});
		h.view.start();
		await h.settle();
		return h;
	}

	function sweep(h: Harness, label: string): void {
		for (let width = 2; width <= 200; width += 1) {
			h.view.invalidate();
			// RAW rows first: probing only the guarded output would let render()'s
			// backstop hide the very overflow this sweep exists to find.
			for (const [index, line] of h.view.buildRows(width).entries()) {
				expect(
					visibleWidth(line) <= width,
					`${label}: raw row ${index} is ${visibleWidth(line)} cells at width ${width}: ${JSON.stringify(line)}`,
				).toBe(true);
			}
			h.view.invalidate();
			for (const [index, line] of h.view.render(width).entries()) {
				expect(
					visibleWidth(line) <= width,
					`${label}: rendered row ${index} is ${visibleWidth(line)} cells at width ${width}`,
				).toBe(true);
			}
		}
	}

	test("loaded view, colour on and off, with CJK labels and aliases", async () => {
		sweep(await loadedView(false), "loaded (no colour)");
		// With colour on, every row carries SGR escapes: a measurement that counted
		// them would report the rows as too wide, and one that ignored the wrong
		// bytes would report a too-wide row as fine.
		sweep(await loadedView(true), "loaded (colour)");
	});

	test("loading, error, and empty-store frames", async () => {
		const loading = makeView({ auth: authPath });
		loading.view.start();
		sweep(loading, "loading"); // spinner row + chrome only
		await loading.settle();

		const failing = makeView({ claudeUrl: claudeUrl.replace("/claude", "/boom"), auth: authPath });
		failing.view.start();
		await failing.settle();
		sweep(failing, "unavailable accounts");
	});

	test("the constant chrome strings are clipped, not emitted whole", async () => {
		const h = await loadedView(false);
		// Both are wider than a 20-column pane; an unfitted constant is exactly
		// how a fixed status row killed a live session before (pi.md).
		expect(VIEW_LEGEND.length).toBeGreaterThan(20);
		const narrow = h.view.render(12);
		expect(narrow.every((line) => visibleWidth(line) <= 12)).toBe(true);
		expect(narrow.some((line) => line.includes("…"))).toBe(true);
	});
});

describe("REQ-012: a banked reset is redeemed from the view, behind an inline confirmation", () => {
	const ORG = "6f1c2a40-1111-4222-8333-944455556666";
	const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
	const REDEEM_URL = `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`;
	const GRANT = {
		id: "grant_a1",
		label: "Opus 5.5 launch reset",
		resets_left: 1,
		ends_at: "2026-01-22T00:00:00+00:00",
		clears: ["five_hour", "seven_day"],
		use_requires_limit: false,
	};

	interface Sent {
		method: string;
		url: string;
		body: unknown;
	}

	/**
	 * Usage requests are answered here too, so the Claude payload can carry a
	 * reset block; they still count in `fetches`. Reset endpoints answer from
	 * `routes`; anything else is a test bug and 404s.
	 */
	function resetFetch(routes: Record<string, () => Response>, cedar: unknown): { fetchImpl: typeof fetch; sent: Sent[] } {
		const sent: Sent[] = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url === claudeUrl) {
				fetches += 1;
				return Response.json({ ...CLAUDE_PAYLOAD, cedar_ember: cedar });
			}
			if (url === codexUrl) {
				fetches += 1;
				return Response.json({ ...CODEX_PAYLOAD, rate_limit_reset_credits: { available_count: 2 } });
			}
			sent.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
			const route = routes[`${method} ${url}`];
			return route ? route() : new Response("not found", { status: 404 });
		}) as typeof fetch;
		return { fetchImpl, sent };
	}

	const banked = { eligible: true, at_limit: true, grants: [GRANT], next_grant_id: GRANT.id };

	async function openOnWork(fetchImpl: typeof fetch): Promise<Harness> {
		const h = makeView({ profiles: { work: cred("rt-w") }, aliases: {}, default: "work", fetchImpl });
		h.view.start();
		await h.settle();
		return h;
	}

	test("the meters show the count, and `x` opens a confirmation naming the exact grant", async () => {
		const { fetchImpl, sent } = resetFetch({}, banked);
		const h = await openOnWork(fetchImpl);
		const before = h.view.render(100).join("\n");
		expect(before).toMatch(/credits\s+1/);
		expect(before).toContain("x reset");

		h.view.handleInput("x");
		await h.settle();
		const text = h.view.render(100).join("\n");
		expect(text).toContain("reset · work (anthropic)");
		expect(text).toContain("  Opus 5.5 launch reset\n");
		expect(text).toContain("  use by Jan 22 00:00\n  refills 5h, weekly\n  1 left");
		expect(text).toContain(RESET_CONFIRM_LEGEND);
		// The confirmation replaces the legend; nothing has been POSTed.
		expect(text).not.toContain("x reset");
		expect(sent.filter((s) => s.method === "POST")).toEqual([]);
	});

	test("n and esc keep the reset — and esc does not close the view", async () => {
		const { fetchImpl, sent } = resetFetch({}, banked);
		const h = await openOnWork(fetchImpl);
		for (const key of ["n", "\x1b"]) {
			h.view.handleInput("x");
			await h.settle();
			expect(h.view.render(100).join("\n")).toContain(RESET_CONFIRM_LEGEND);
			h.view.handleInput(key);
			expect(h.view.render(100).join("\n")).not.toContain(RESET_CONFIRM_LEGEND);
		}
		expect(h.closed).toBe(0);
		expect(sent.filter((s) => s.method === "POST")).toEqual([]);
	});

	test("y redeems once, ignores keys while in flight, then refetches the meters", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { fetchImpl, sent } = resetFetch(
			{
				[`GET ${PROFILE_URL}`]: () => Response.json({ organization: { uuid: ORG } }),
				[`POST ${REDEEM_URL}`]: () => Response.json({ result: "reset", resets_left: 0, cleared: ["five_hour"] }),
			},
			banked,
		);
		const gated = (async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input) === REDEEM_URL) await gate;
			return fetchImpl(input, init);
		}) as typeof fetch;
		const h = await openOnWork(gated);
		h.view.handleInput("x");
		await h.settle();

		const fetchesBefore = fetches;
		h.view.handleInput("y");
		await h.settle();
		expect(h.view.render(100).join("\n")).toContain("using reset…");
		// A sent redeem cannot be called back: no cancel, no close, no second send.
		h.view.handleInput("\x1b");
		h.view.handleInput("y");
		expect(h.closed).toBe(0);

		release();
		await h.settle();
		const posts = sent.filter((s) => s.method === "POST");
		expect(posts).toHaveLength(1);
		expect(posts[0]!.body).toEqual({ program: "cedar_ember", grant_id: "grant_a1", request_id: "req-view-1" });
		// A used reset changed the limits, so this is the one action that refetches.
		expect(fetches).toBeGreaterThan(fetchesBefore);
		const text = h.view.render(100).join("\n");
		expect(text).toContain("work: reset used · 5h refilled · 0 left");
		expect(text).toContain("x reset");
	});

	test("a refusal keeps the meters as they are and says so", async () => {
		const { fetchImpl } = resetFetch(
			{
				[`GET ${PROFILE_URL}`]: () => Response.json({ organization: { uuid: ORG } }),
				[`POST ${REDEEM_URL}`]: () => Response.json({ result: "not_limited" }),
			},
			{ ...banked, at_limit: false, grants: [{ ...GRANT, use_requires_limit: true }] },
		);
		const h = await openOnWork(fetchImpl);
		h.view.handleInput("x");
		await h.settle();
		expect(h.view.render(100).join("\n")).toContain("works only at a usage limit");
		const fetchesBefore = fetches;
		h.view.handleInput("y");
		await h.settle();
		expect(fetches).toBe(fetchesBefore);
		expect(h.view.render(100).join("\n")).toContain("work: not at a usage limit · reset kept");
	});

	test("nothing banked: a status line, no confirmation", async () => {
		const { fetchImpl } = resetFetch({}, { eligible: false, ineligible_reason: "no_grant", grants: [], next_grant_id: null });
		const h = await openOnWork(fetchImpl);
		h.view.handleInput("x");
		await h.settle();
		const text = h.view.render(100).join("\n");
		expect(text).toContain("work: no limit resets available");
		expect(text).not.toContain(RESET_CONFIRM_LEGEND);
	});

	test("the built-in Codex login redeems on Pi's snapshot, leaving auth.json untouched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "seat-view-reset-"));
		try {
			const codexAuth = join(dir, "auth.json");
			writeFileSync(
				codexAuth,
				JSON.stringify({ "openai-codex": { type: "oauth", refresh: "rt-cx", access: "at-cx", expires: FRESH, accountId: "acct-1" } }),
				{ mode: 0o600 },
			);
			const before = Bun.file(codexAuth).size;
			const { fetchImpl, sent } = resetFetch(
				{
					[`GET ${CODEX_RESET_CREDITS_URL}`]: () =>
						Response.json({ available_count: 1, credits: [{ id: "credit-1", status: "available", title: "Full reset (Weekly + 5 hr)" }] }),
					[`POST ${CODEX_RESET_CONSUME_URL}`]: () => Response.json({ code: "nothing_to_reset" }),
				},
				null,
			);
			const h = makeView({ profiles: { work: cred("rt-w") }, aliases: {}, default: "work", auth: codexAuth, fetchImpl });
			h.view.start();
			await h.settle();
			// Walk to the Codex built-in row: the last account (the cursor clamps).
			for (let i = 0; i < 5; i += 1) h.view.handleInput("j");
			h.view.handleInput("x");
			await h.settle();
			expect(h.view.render(100).join("\n")).toContain("reset · Codex (openai-codex)");
			h.view.handleInput("y");
			await h.settle();
			expect(sent.find((s) => s.method === "POST")?.body).toEqual({ redeem_request_id: "req-view-1", credit_id: "credit-1" });
			expect(h.view.render(100).join("\n")).toContain("Codex: nothing to reset right now · reset kept");
			expect(Bun.file(codexAuth).size).toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("x is matched through matchesKey, like every other key", () => {
		expect(isResetKey("x")).toBe(true);
		expect(isResetKey("r")).toBe(false);
	});

	test("render probe: the checking and confirmation frames never overflow at widths 2–200", async () => {
		const { fetchImpl } = resetFetch({}, { ...banked, at_limit: false, grants: [{ ...GRANT, use_requires_limit: true }] });
		const h = await openOnWork(fetchImpl);
		h.view.handleInput("x");
		for (const settled of [false, true]) {
			if (settled) await h.settle();
			for (let width = 2; width <= 200; width += 1) {
				h.view.invalidate();
				for (const line of h.view.buildRows(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		expect(h.view.render(100).join("\n")).toContain(RESET_CONFIRM_LEGEND);
	});

	test("at 40 columns the deadline and the keys are still on screen", async () => {
		const { fetchImpl } = resetFetch({}, { ...banked, at_limit: false, grants: [{ ...GRANT, use_requires_limit: true }] });
		const h = await openOnWork(fetchImpl);
		h.view.handleInput("x");
		await h.settle();
		const text = h.view.render(40).join("\n");
		expect(text).toContain("use by Jan 22 00:00");
		expect(text).toContain(RESET_CONFIRM_LEGEND);
	});
});
