import { describe, expect, test } from "bun:test";
import golden from "../fixtures/python-golden.json";
import { planLayout, type Layout } from "../../src/usage/layout.ts";
import {
	accountLine,
	hintLine,
	meterLine,
	renderClaudeUsage,
	renderCodexUsage,
	type ClaudeUsage,
	type CodexUsage,
	type RenderOptions,
} from "../../src/usage/render.ts";

// Mirrors the generator: frozen clock 2026-01-15T12:00:00Z, TZ=UTC, no color.
const FROZEN_NOW = new Date("2026-01-15T12:00:00Z");
const OPTS: RenderOptions = { color: false, now: () => FROZEN_NOW, timeZone: "UTC" };

const iso = (deltaSeconds: number) => new Date(FROZEN_NOW.getTime() + deltaSeconds * 1000).toISOString();
const epoch = (deltaSeconds: number) => Math.trunc((FROZEN_NOW.getTime() + deltaSeconds * 1000) / 1000);
const dt = (deltaSeconds: number) => new Date(FROZEN_NOW.getTime() + deltaSeconds * 1000);

const CLAUDE_PAYLOAD: ClaudeUsage = {
	limits: [
		{ kind: "session", percent: 42, resets_at: iso(2 * 3600 + 31 * 60) },
		{ kind: "weekly_all", percent: 63, resets_at: iso(3 * 86_400 + 2 * 3600) },
		{
			kind: "weekly_sonnet",
			group: "weekly",
			scope: { model: { display_name: "Sonnet" } },
			percent: 88,
			resets_at: iso(3 * 86_400 + 2 * 3600),
		},
	],
	extra_usage: { is_enabled: true, used_credits: 12_345, monthly_limit: 50_000, decimal_places: 2 },
};

const CLAUDE_BOUNDARIES: ClaudeUsage = {
	limits: [
		{ kind: "session", percent: 0, resets_at: iso(45 * 60) },
		{ kind: "weekly_all", percent: 100, resets_at: iso(-60) },
		{ kind: "weekly_opus", scope: { model: { display_name: "Opus" } }, percent: 70 },
	],
};

const CODEX_PAYLOAD: CodexUsage = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { limit_window_seconds: 5 * 3600, used_percent: 37, reset_at: epoch(4 * 3600 + 12 * 60) },
		secondary_window: { limit_window_seconds: 7 * 86_400, used_percent: 91, reset_at: epoch(6 * 86_400 + 23 * 3600) },
	},
	rate_limit_reset_credits: { available_count: 3 },
};

const SCENARIOS: Record<string, (layout: Layout) => string[]> = {
	claude_live_single: (layout) => [
		accountLine(layout, "Claude", [], true, "", OPTS),
		...renderClaudeUsage(layout, CLAUDE_PAYLOAD, OPTS),
	],
	claude_profiles: (layout) => [
		accountLine(layout, "work", ["w"], true, "", OPTS),
		...renderClaudeUsage(layout, CLAUDE_PAYLOAD, OPTS),
		accountLine(layout, "personal", [], false, "", OPTS),
		...renderClaudeUsage(layout, CLAUDE_BOUNDARIES, OPTS),
	],
	cjk_label: (layout) => [
		accountLine(layout, "工作用帳號", ["工"], true, "", OPTS),
		...renderClaudeUsage(layout, CLAUDE_PAYLOAD, OPTS),
	],
	codex_block: (layout) => [
		accountLine(layout, "Codex", [], true, "plus", OPTS),
		...renderCodexUsage(layout, CODEX_PAYLOAD, OPTS),
	],
	// Python's report() opens the block with a blank separator line (open_block).
	expired_dormant: (layout) => [
		"",
		accountLine(layout, "personal", ["p"], false, "token expired", OPTS),
		hintLine(layout, "`seat personal` then one pi run refreshes it", OPTS),
	],
	reset_edges: (layout) => [
		meterLine(layout, "5h", 50, dt(30 * 60), OPTS),
		meterLine(layout, "weekly", 50, dt(5 * 3600 + 7 * 60), OPTS),
		meterLine(layout, "edge", 50, dt(2 * 86_400 + 3600), OPTS),
		meterLine(layout, "past", 50, dt(-30), OPTS),
		meterLine(layout, "nores", 50, null, OPTS),
	],
};

describe("AC-011a: widths 2–200 row-identical to the Python golden fixture", () => {
	for (const [name, render] of Object.entries(SCENARIOS)) {
		test(name, () => {
			const scenario = (golden.scenarios as Record<string, Record<string, string[]>>)[name];
			expect(scenario).toBeDefined();
			for (let width = 2; width <= 200; width += 1) {
				const expected = scenario![String(width)];
				expect(expected, `${name} width ${width} missing from fixture`).toBeDefined();
				const actual = render(planLayout(width));
				expect(actual, `${name} @ width ${width}`).toEqual(expected!);
			}
		});
	}

	test("no row overflows its width budget", () => {
		for (const render of Object.values(SCENARIOS)) {
			for (const width of [2, 3, 10, 40, 59, 60, 80, 200]) {
				for (const line of render(planLayout(width))) {
					expect(Bun.stringWidth(line)).toBeLessThanOrEqual(Math.max(0, width - 1));
				}
			}
		}
	});
});

describe("AC-011b: width ≥ 40 semantic retention", () => {
	test("account name, meter label, percent survive every width ≥ 40", () => {
		for (let width = 40; width <= 200; width += 1) {
			const layout = planLayout(width);
			const lines = SCENARIOS["claude_profiles"]!(layout);
			expect(lines.some((l) => l.includes("work"))).toBe(true);
			expect(lines.some((l) => l.includes("personal"))).toBe(true);
			expect(lines.some((l) => l.includes("5h"))).toBe(true);
			expect(lines.some((l) => l.includes("weekly"))).toBe(true);
			expect(lines.some((l) => l.includes("42%"))).toBe(true);
			expect(lines.some((l) => l.includes("100%"))).toBe(true);
		}
	});

	test("truncation always carries an ellipsis", () => {
		for (let width = 40; width <= 60; width += 1) {
			const layout = planLayout(width);
			const lines = SCENARIOS["cjk_label"]!(layout);
			const header = lines[0]!;
			// Either the full CJK name fits or the cut is marked.
			expect(header.includes("工作用帳號") || header.includes("…")).toBe(true);
		}
	});
});

describe("TS-native scenarios (states Python cannot express)", () => {
	const W = 80;
	const layout = planLayout(W);

	test("named Codex profile block", () => {
		const lines = [
			accountLine(layout, "codex-work", ["cw"], true, "plus", OPTS),
			...renderCodexUsage(layout, CODEX_PAYLOAD, OPTS),
		];
		expect(lines).toEqual([
			"● codex-work (cw) · plus",
			"  5h             ███████░░░░░░░░░░░░░   37%  in 4h12m · 16:12",
			"  weekly         ██████████████████░░   91%  in 6d23h · Thu 11:00",
			"  credits        3",
		]);
	});

	test("dual provider view: anthropic block then codex block", () => {
		const lines = [
			accountLine(layout, "work", [], true, "", OPTS),
			...renderClaudeUsage(layout, CLAUDE_PAYLOAD, OPTS),
			accountLine(layout, "codex-main", [], false, "", OPTS),
			...renderCodexUsage(layout, CODEX_PAYLOAD, OPTS),
		];
		expect(lines[0]).toBe("● work");
		expect(lines[5]).toBe("○ codex-main");
		expect(lines).toHaveLength(9);
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(W - 1);
	});

	test("expired-refresh: dormant profile whose seat-side refresh failed", () => {
		const lines = [
			accountLine(layout, "personal", [], false, "refresh failed", OPTS),
			hintLine(layout, "run `/seat login personal` to mint a new grant", OPTS),
		];
		expect(lines).toEqual([
			"○ personal · refresh failed",
			"  run `/seat login personal` to mint a new grant",
		]);
	});
});
