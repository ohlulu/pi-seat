/**
 * Pin badge formatter (REQ-002 / AC-026) — pure module, zero Pi imports.
 *
 * The badge reports the session's immutable PI_SEAT pin in Pi's footer
 * status line. Slot order is fixed to PROVIDER_IDS (anthropic first, codex
 * second); a leading "/" marks an empty anthropic slot so a codex-only pin
 * cannot be misread as an anthropic one. No pin, no badge — the common
 * unpinned session renders zero seat chrome.
 *
 * An invalid PI_SEAT gets an error badge instead of nothing: with every
 * turn aborting (AC-004), an empty footer would read as a normal unpinned
 * session. Per-turn fail-closed (REQ-004) deliberately stays out — that is
 * transient per-provider health, not the session's pin identity.
 */
import type { ProviderId } from "../store/schema.ts";

export type PinBadge = { kind: "pin" | "error"; text: string };

export function pinBadge(pins: Partial<Record<ProviderId, string>>, invalid: boolean): PinBadge | undefined {
	if (invalid) return { kind: "error", text: "PI_SEAT invalid" };
	const anthropic = pins["anthropic"];
	const codex = pins["openai-codex"];
	if (anthropic === undefined && codex === undefined) return undefined;
	const slots =
		anthropic !== undefined && codex !== undefined
			? `${anthropic}/${codex}`
			: anthropic !== undefined
				? anthropic
				: `/${codex}`;
	return { kind: "pin", text: `:${slots}:` };
}
