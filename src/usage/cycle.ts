/**
 * Billing-cycle arithmetic for API-key spend (REQ-014, DEC-016). Pure and
 * clock-injected: the caller passes `now`, nothing here reads the time or does
 * I/O.
 *
 * A cycle starts at 00:00 of its anchor date in the cycle's own time zone and
 * restarts on the anchor's day of every later month. A month too short for that
 * day restarts on its last day (31 → Feb 28/29), the way a Stripe billing
 * anchor behaves.
 */

import { isIsoDate, type BillingCycle } from "../store/schema.ts";

/** A calendar date with no zone attached. Month is 1-based. */
interface CalendarDate {
	year: number;
	month: number;
	day: number;
}

export type CycleWindow =
	/** Today is before the anchor: there is no window to measure yet. */
	| { state: "pending"; startDate: string }
	| {
			state: "active";
			/** The window's first day, YYYY-MM-DD in the cycle's zone. */
			startDate: string;
			/** The day the next window starts, YYYY-MM-DD in the cycle's zone. */
			resetDate: string;
			/** 00:00 of `startDate` in the cycle's zone. */
			start: Date;
	  };

/**
 * The date a user typed, as YYYY-MM-DD: `MM/DD/YYYY` or `YYYY-MM-DD`, nothing
 * else. Undefined for any other spelling or a date that does not exist.
 */
export function parseCycleDate(input: string): string | undefined {
	const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input);
	const iso = us === null ? input : `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
	return isIsoDate(iso) ? iso : undefined;
}

/** The window `now` falls in. */
export function currentCycle(cycle: BillingCycle, now: Date): CycleWindow {
	const anchor = fromIso(cycle.anchor);
	const today = calendarDateIn(now, cycle.timeZone);
	if (compare(today, anchor) < 0) return { state: "pending", startDate: cycle.anchor };

	let start = cycleDay(today.year, today.month, anchor.day);
	if (compare(today, start) < 0) start = cycleDay(...previousMonth(today.year, today.month), anchor.day);
	const reset = cycleDay(...nextMonth(start.year, start.month), anchor.day);
	return {
		state: "active",
		startDate: toIso(start),
		resetDate: toIso(reset),
		start: midnightIn(start, cycle.timeZone),
	};
}

/** `instant` as the zone's wall clock: `YYYY-MM-DD HH:MM`, date dropped when it is `now`'s date. */
export function formatWallClock(instant: Date, now: Date, timeZone: string): string {
	const parts = zoneParts(instant, timeZone);
	const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
	const date = toIso(parts);
	return date === toIso(calendarDateIn(now, timeZone)) ? time : `${date} ${time}`;
}

// --- calendar helpers --------------------------------------------------------

function cycleDay(year: number, month: number, anchorDay: number): CalendarDate {
	return { year, month, day: Math.min(anchorDay, daysInMonth(year, month)) };
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function previousMonth(year: number, month: number): [number, number] {
	return month === 1 ? [year - 1, 12] : [year, month - 1];
}

function nextMonth(year: number, month: number): [number, number] {
	return month === 12 ? [year + 1, 1] : [year, month + 1];
}

function compare(a: CalendarDate, b: CalendarDate): number {
	return a.year - b.year || a.month - b.month || a.day - b.day;
}

function fromIso(value: string): CalendarDate {
	const [year, month, day] = value.split("-").map(Number) as [number, number, number];
	return { year, month, day };
}

function toIso(date: CalendarDate): string {
	return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

// --- time-zone helpers -------------------------------------------------------

interface ZoneParts extends CalendarDate {
	hour: number;
	minute: number;
	second: number;
}

function zoneParts(instant: Date, timeZone: string): ZoneParts {
	const format = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const parts: Record<string, number> = {};
	for (const part of format.formatToParts(instant)) {
		if (part.type !== "literal") parts[part.type] = Number(part.value);
	}
	return {
		year: parts["year"]!,
		month: parts["month"]!,
		day: parts["day"]!,
		hour: parts["hour"]!,
		minute: parts["minute"]!,
		second: parts["second"]!,
	};
}

function calendarDateIn(instant: Date, timeZone: string): CalendarDate {
	const { year, month, day } = zoneParts(instant, timeZone);
	return { year, month, day };
}

/** The zone's UTC offset at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
	const p = zoneParts(new Date(instant), timeZone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * 00:00 of `date` in `timeZone`. The offset is read twice because the first
 * guess can sit on the other side of a DST change from the answer.
 */
function midnightIn(date: CalendarDate, timeZone: string): Date {
	const wall = Date.UTC(date.year, date.month - 1, date.day);
	let instant = wall - offsetAt(wall, timeZone);
	instant = wall - offsetAt(instant, timeZone);
	return new Date(instant);
}
