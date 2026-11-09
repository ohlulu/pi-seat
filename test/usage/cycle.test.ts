/**
 * REQ-014 billing-cycle arithmetic (DEC-016): date parsing, the window a moment
 * falls in, and 00:00 in the cycle's own zone. Run: bun test test/usage/cycle.test.ts
 */
import { describe, expect, test } from "bun:test";
import { currentCycle, formatWallClock, parseCycleDate } from "../../src/usage/cycle.ts";

describe("parseCycleDate", () => {
	test("MM/DD/YYYY and YYYY-MM-DD name the same day", () => {
		expect(parseCycleDate("11/27/2026")).toBe("2026-11-27");
		expect(parseCycleDate("2026-11-27")).toBe("2026-11-27");
		expect(parseCycleDate("1/5/2027")).toBe("2027-01-05");
	});

	test("other spellings and impossible dates are refused", () => {
		for (const input of ["27/11/2026", "2/30/2026", "2026-02-30", "2026/11/27", "11-27-2026", "2026-1-5", "", "tomorrow"]) {
			expect(parseCycleDate(input)).toBeUndefined();
		}
	});
});

describe("AC-046: currentCycle", () => {
	const cycle = { anchor: "2026-01-31", timeZone: "Asia/Taipei" };

	test("a short month resets on its last day", () => {
		expect(currentCycle(cycle, new Date("2026-02-15T04:00:00Z"))).toMatchObject({ startDate: "2026-01-31", resetDate: "2026-02-28" });
		expect(currentCycle(cycle, new Date("2026-03-05T04:00:00Z"))).toMatchObject({ startDate: "2026-02-28", resetDate: "2026-03-31" });
	});

	test("a future date only names the reset day: the current window ends on it", () => {
		const reset = { anchor: "2026-11-27", timeZone: "Asia/Taipei" };
		expect(currentCycle(reset, new Date("2026-11-09T14:43:00Z"))).toMatchObject({ startDate: "2026-10-27", resetDate: "2026-11-27" });
		expect(currentCycle(cycle, new Date("2026-01-20T04:00:00Z"))).toMatchObject({ startDate: "2025-12-31", resetDate: "2026-01-31" });
	});

	test("the start is local midnight converted to UTC", () => {
		const window = currentCycle({ anchor: "2026-11-27", timeZone: "Asia/Taipei" }, new Date("2026-12-01T00:00:00Z"));
		expect(window.start.toISOString()).toBe("2026-11-26T16:00:00.000Z");
	});

	test("the reset day is judged in the cycle's zone, not UTC", () => {
		// 2026-11-26T17:00Z is already 11-27 01:00 in Taipei: the new window has begun.
		const zone = { anchor: "2026-11-27", timeZone: "Asia/Taipei" };
		expect(currentCycle(zone, new Date("2026-11-26T17:00:00Z"))).toMatchObject({ startDate: "2026-11-27", resetDate: "2026-12-27" });
		expect(currentCycle(zone, new Date("2026-11-26T15:00:00Z"))).toMatchObject({ startDate: "2026-10-27", resetDate: "2026-11-27" });
	});

	test("midnight survives a DST change", () => {
		// New York leaves DST on 2026-11-01: midnight on 11-15 is UTC-5.
		const window = currentCycle({ anchor: "2026-10-15", timeZone: "America/New_York" }, new Date("2026-11-20T12:00:00Z"));
		expect(window.start.toISOString()).toBe("2026-11-15T05:00:00.000Z");
	});

	test("December rolls into January", () => {
		expect(currentCycle({ anchor: "2026-10-31", timeZone: "UTC" }, new Date("2027-01-10T00:00:00Z"))).toMatchObject({
			startDate: "2026-12-31",
			resetDate: "2027-01-31",
		});
	});
});

describe("formatWallClock", () => {
	test("time only on the same day, date and time otherwise", () => {
		const now = new Date("2026-11-30T08:00:00Z"); // 16:00 Taipei
		expect(formatWallClock(new Date("2026-11-30T06:05:00Z"), now, "Asia/Taipei")).toBe("14:05");
		expect(formatWallClock(new Date("2026-11-29T06:05:00Z"), now, "Asia/Taipei")).toBe("2026-11-29 14:05");
	});
});
