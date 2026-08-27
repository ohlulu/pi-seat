/**
 * Pin badge formatter (REQ-002 / AC-026) — pure module, zero Pi imports.
 *
 * The badge reports the session's immutable PI_SEAT pin in Pi's footer
 * status line. Slot order is fixed to PROVIDER_IDS (anthropic first, codex
 * second); a leading "/" marks an empty anthropic slot so a codex-only pin
 * cannot be misread as an anthropic one. No pin, no badge — the common
 * unpinned session renders zero seat chrome.
 *
 * A startup problem gets a badge instead of nothing: with every turn
 * aborting, an empty footer would read as a normal unpinned session. The two
 * problems are distinct because they have different fixes — an invalid
 * PI_SEAT is fixed in the environment, an unreadable store is fixed on disk.
 * Per-turn fail-closed (REQ-004) stays out: that is transient per-provider
 * health, not the session's pin identity.
 */
import type { ProviderId } from "../store/schema.ts";

/** Startup failures that replace the pin badge; see index.ts for their notices. */
export type BadgeProblem = "pin-invalid" | "store-unreadable";

export type PinBadge = { kind: "pin" | "error"; text: string };

const PROBLEM_TEXT: Record<BadgeProblem, string> = {
	"pin-invalid": "PI_SEAT invalid",
	"store-unreadable": "seat store error",
};

/**
 * Labels forbid ":" and "," but NOT "/", which is the slot delimiter — an
 * anthropic-only label "a/b" would otherwise render exactly like the two-pin
 * badge for "a" and "b". Escaped so every badge has one reading.
 */
function escapeSlot(label: string): string {
	return label.replace(/\\/g, "\\\\").replace(/\//g, "\\/");
}

export function pinBadge(
	pins: Partial<Record<ProviderId, string>>,
	problem?: BadgeProblem | undefined,
): PinBadge | undefined {
	if (problem !== undefined) return { kind: "error", text: PROBLEM_TEXT[problem] };
	const anthropic = pins["anthropic"];
	const codex = pins["openai-codex"];
	if (anthropic === undefined && codex === undefined) return undefined;
	const slots =
		anthropic !== undefined && codex !== undefined
			? `${escapeSlot(anthropic)}/${escapeSlot(codex)}`
			: anthropic !== undefined
				? escapeSlot(anthropic)
				: `/${escapeSlot(codex as string)}`;
	return { kind: "pin", text: `:${slots}:` };
}
