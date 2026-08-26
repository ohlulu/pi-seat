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
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStore, type SeatCredential } from "../../src/store/schema.ts";
import { InMemorySeatStorageBackend, encodeStore } from "../../src/store/storage.ts";
import type { RefreshCallback } from "../../src/store/refresh.ts";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "../../src/usage/render.ts";
import { IDLE_TICK_MS, LOADING_TEXT, UsageView, VIEW_LEGEND, VIEW_TITLE, type UsageViewDeps } from "../../src/extension/usage-view.ts";

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

function cred(refresh: string, expires = FRESH): SeatCredential {
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
		profiles?: Record<string, SeatCredential>;
		aliases?: Record<string, string>;
		default?: string;
		pins?: Record<string, string>;
		auth?: string;
		codexUrl?: string;
		claudeUrl?: string;
		color?: boolean;
		clock?: { ms: number };
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
		authPath: options.auth ?? emptyAuthPath,
		pins: (options.pins ?? {}) as UsageViewDeps["pins"],
		refreshFor: () => refresh,
		fetchOptions: {
			claudeUrl: options.claudeUrl ?? claudeUrl,
			codexUrl: options.codexUrl ?? codexUrl,
			now: () => harness.clock.ms,
		},
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
		// The pinned account is the live one; the dot precedes its name.
		expect(lines.some((l) => l.startsWith("● personal"))).toBe(true);
		expect(lines.some((l) => l.startsWith("○ work (w)"))).toBe(true);
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
		expect(lines.findIndex((l) => l.startsWith("● personal"))).toBeLessThan(
			lines.findIndex((l) => l.startsWith("○ work")),
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
