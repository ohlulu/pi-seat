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
import { cellClip } from "../usage/cells.ts";

export const SECRET_INPUT_LEGEND = "enter save · esc cancel";
const BULLET = "•";

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

	/** Every row is clipped to `width`: Pi's renderer throws on an overflowing row. */
	render(width: number): string[] {
		const budget = Math.max(0, width);
		const mask = BULLET.repeat([...this.input.getValue()].length);
		return [this.title, `> ${mask}`, SECRET_INPUT_LEGEND].map((line) => cellClip(line, budget));
	}

	invalidate(): void {}
}
