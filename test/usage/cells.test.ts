import { describe, expect, test } from "bun:test";
import probe from "../fixtures/cells-probe.json";
import { cellClip, cellWidth, fit } from "../../src/usage/cells.ts";

describe("cellWidth parity with Python seat", () => {
	test("matches every probe sample", () => {
		for (const [text, expected] of Object.entries(probe.widths)) {
			expect(cellWidth(text), `cellWidth(${JSON.stringify(text)})`).toBe(expected as number);
		}
	});

	test("W/F = 2, Ambiguous and narrow = 1", () => {
		expect(cellWidth("工")).toBe(2); // W
		expect(cellWidth("ｗ")).toBe(2); // F
		expect(cellWidth("●")).toBe(1); // Ambiguous — deliberately 1
		expect(cellWidth("…")).toBe(1); // Ambiguous
		expect(cellWidth("ﾊ")).toBe(1); // Halfwidth katakana
		expect(cellWidth("a")).toBe(1);
	});
});

describe("cellClip parity with Python seat", () => {
	test("matches every probe case", () => {
		for (const { text, width, out } of probe.clips) {
			expect(cellClip(text, width), `cellClip(${JSON.stringify(text)}, ${width})`).toBe(out);
		}
	});

	test("wide glyph at the cut leaves padding before the ellipsis", () => {
		// "工作" is 4 cells; clipping to 4 fits exactly, clipping to 3 cuts
		// before the second wide glyph, leaving one spare cell as padding.
		expect(cellClip("工作", 4)).toBe("工作");
		expect(cellClip("工作用", 4)).toBe("工 …");
	});
});

describe("fit parity with Python seat", () => {
	test("matches every probe case", () => {
		for (const { text, width, out } of probe.fits) {
			expect(fit(text, width), `fit(${JSON.stringify(text)}, ${width})`).toBe(out);
		}
	});

	test("pads to exact width, clips over width", () => {
		expect(fit("5h", 8)).toBe("5h      ");
		expect(fit("weekly Sonnet", 8)).toBe("weekly …");
		expect(cellWidth(fit("工作用帳號", 8))).toBe(8);
	});
});
