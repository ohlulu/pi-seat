/**
 * Masked single-line input for `/seat login --api-key` (REQ-013, DEC-015).
 *
 * Pi's `ctx.ui.input` echoes what is typed, and a key on screen can leave in a
 * screenshot or a recording. Editing is delegated to pi-tui's `Input`, so
 * paste, the Kitty keyboard protocol and the delete keys behave as everywhere
 * else in Pi; this component only draws a bullet per character instead of the
 * value. Pi-free like the usage view: a test drives render/handleInput with no
 * terminal.
 */

import { Input } from "@earendil-works/pi-tui";
import { cellClip, stripAnsi, visibleCellWidth } from "../usage/cells.ts";

export const SECRET_INPUT_LEGEND = "enter save · esc cancel";
const BULLET = "•";
const CURSOR_ON = "\x1b[7m";
const CURSOR_OFF = "\x1b[27m";

export interface SecretInputCallbacks {
	onSubmit: (value: string) => void;
	onCancel: () => void;
}

export class SecretInput {
	private readonly input = new Input();

	constructor(
		private readonly title: string,
		callbacks: SecretInputCallbacks,
	) {
		this.input.onSubmit = (value) => callbacks.onSubmit(value);
		this.input.onEscape = () => callbacks.onCancel();
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	/**
	 * Every row is clipped to `width`: Pi's renderer throws on an overflowing row.
	 * The mask scrolls to keep the cursor (an inverse cell) in view.
	 */
	render(width: number): string[] {
		const budget = Math.max(0, width);
		const length = this.input.getValue().length;
		const cursor = this.cursorAt(length);
		const room = Math.max(1, budget - 2);
		const cells = length + 1; // the bullets, plus the cell after the last one
		const start = cells <= room ? 0 : Math.min(Math.max(0, cursor - room + 1), cells - room);
		let mask = "";
		for (let index = start; index < Math.min(cells, start + room); index += 1) {
			const glyph = index < length ? BULLET : " ";
			mask += index === cursor ? `${CURSOR_ON}${glyph}${CURSOR_OFF}` : glyph;
		}
		const row = `> ${mask}`;
		return [
			cellClip(this.title, budget),
			visibleCellWidth(row) <= budget ? row : cellClip(stripAnsi(row), budget),
			cellClip(SECRET_INPUT_LEGEND, budget),
		];
	}

	/** pi-tui's Input has no cursor accessor; its own field is read, else the end of the value. */
	private cursorAt(length: number): number {
		const cursor = (this.input as unknown as { cursor?: unknown }).cursor;
		return typeof cursor === "number" ? Math.max(0, Math.min(length, cursor)) : length;
	}

	invalidate(): void {}
}
