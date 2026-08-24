/**
 * /seat command adapter (T032; REQ-003, REQ-007): parses `/seat …` argument
 * strings and routes to the T020 mutation handlers. Bare `/seat <selector>` is
 * shorthand for `use`. The destructive-confirm policy surfaces through
 * ctx.ui.confirm; AC-016's "default updated, session keeps its pin" notice is
 * emitted here because only the extension knows the session's pins.
 */

import type { AuthPrompt, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isValidLabel, type ProviderId, type SeatCredential } from "../store/schema.ts";
import type { SeatStorageBackend } from "../store/storage.ts";
import { decodeStore } from "../store/storage.ts";
import { parseSelector, resolveSelection } from "../store/selector.ts";
import { adapterFor, type SeatProviderAdapter } from "./oauth.ts";
import {
	CommandError,
	DEFAULT_KEYWORD,
	loginProfile,
	removeSelection,
	renameProfile,
	runMutation,
	useSelection,
} from "./commands.ts";

export interface SeatCommandDeps {
	backend: SeatStorageBackend;
	adapters: SeatProviderAdapter[];
	pins: Partial<Record<ProviderId, string>>;
}

const SUBCOMMANDS = new Set(["use", "login", "rm", "rename", "status", "whoami", "usage", "help"]);

export const SEAT_COMMAND_DESCRIPTION = "Manage seat account profiles (use/login/rm/rename/status)";

export async function runSeatCommand(args: string, ctx: ExtensionCommandContext, deps: SeatCommandDeps): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
	try {
		if (tokens.length === 0 || tokens[0] === "status" || tokens[0] === "whoami") {
			ctx.ui.notify(statusText(deps), "info");
			return;
		}
		const [head, ...rest] = tokens as [string, ...string[]];
		switch (head) {
			case "help":
				ctx.ui.notify("usage: /seat [use] <selector> | login <selector> [-a <alias>]… | rm <selector> | rename <old> <new> | status", "info");
				return;
			case "usage":
				ctx.ui.notify("usage meters live in the `seat` CLI; run `seat` in a terminal", "info");
				return;
			case "use":
				await handleUse(rest, ctx, deps);
				return;
			case "login":
				await handleLogin(rest, ctx, deps);
				return;
			case "rm":
				await handleRm(rest, ctx, deps);
				return;
			case "rename":
				await handleRename(rest, ctx, deps);
				return;
			default:
				if (SUBCOMMANDS.has(head)) throw new CommandError(`unhandled subcommand "${head}"`);
				// Bare shorthand: /seat <selector> ≡ /seat use <selector>
				await handleUse(tokens, ctx, deps);
				return;
		}
	} catch (error) {
		ctx.ui.notify(`seat: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function handleUse(rest: string[], ctx: ExtensionCommandContext, deps: SeatCommandDeps): Promise<void> {
	const selector = rest[0];
	if (selector === undefined || rest.length > 1) throw new CommandError("usage: /seat use <selector>");
	const result = runMutation(deps.backend, (store) => useSelection(store, selector));

	const pinned = deps.pins[result.provider];
	const suffix = pinned !== undefined ? ` — this session keeps its pin (${pinned})` : "";
	if (result.action === "clear") {
		ctx.ui.notify(`seat: ${result.provider} default cleared; Pi built-in login applies${suffix}`, "info");
	} else {
		ctx.ui.notify(`seat: ${result.provider} default is now "${result.label}"${suffix}`, "info");
	}
}

async function handleLogin(rest: string[], ctx: ExtensionCommandContext, deps: SeatCommandDeps): Promise<void> {
	const { selector, aliases } = parseLoginArgs(rest);
	// Validate grammar and charset, then run the overwrite check, all BEFORE the
	// OAuth flow — the browser round-trip is never wasted on a login the user
	// then declines to store (AC-013). The check is a pure read; the final
	// locked store re-detects any race.
	const parsed = parseSelector(selector);
	if (parsed.name === DEFAULT_KEYWORD) throw new CommandError(`"${DEFAULT_KEYWORD}" is a reserved name`);
	for (const alias of aliases) {
		if (!isValidLabel(alias)) throw new CommandError(`invalid alias "${alias}" (":" and "," are not allowed)`);
	}
	const exists = deps.backend.read((current) => {
		const store = decodeStore(current);
		return Object.hasOwn(store.providers[parsed.provider]?.profiles ?? {}, parsed.name);
	});
	let confirmedOverwrite = false;
	if (exists) {
		const ok = await ctx.ui.confirm("seat login", `Profile "${parsed.name}" already exists. Overwrite its grant?`);
		if (!ok) {
			ctx.ui.notify("seat: login cancelled; existing profile kept", "info");
			return;
		}
		confirmedOverwrite = true;
	}

	const adapter = adapterFor(deps.adapters, parsed.provider);
	const controller = new AbortController();
	const credential = (await adapter.oauth.login(buildInteraction(ctx, controller.signal))) as SeatCredential;

	const result = runMutation(deps.backend, (store) =>
		loginProfile(store, selector, credential, aliases, { confirmedOverwrite }),
	);
	if (result.action !== "stored") throw new CommandError("login raced another mutation; try again");
	ctx.ui.notify(
		`seat: stored ${result.provider} profile "${result.label}"${aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : ""}${result.overwrote ? " (overwrote previous grant)" : ""}`,
		"info",
	);
}

async function handleRm(rest: string[], ctx: ExtensionCommandContext, deps: SeatCommandDeps): Promise<void> {
	const selector = rest.filter((t) => t !== "--force" && t !== "--no-input")[0];
	const force = rest.includes("--force") || rest.includes("--no-input");
	if (selector === undefined) throw new CommandError("usage: /seat rm <selector> [--force]");

	const pre = runMutation(deps.backend, (store) => removeSelection(store, selector, { confirmedProfileRemoval: force }));
	if (pre.action === "needs-confirm") {
		const ok = await ctx.ui.confirm("seat rm", `Delete profile "${pre.label}" and its grant? This cannot be undone.`);
		if (!ok) {
			ctx.ui.notify("seat: rm cancelled", "info");
			return;
		}
		const result = runMutation(deps.backend, (store) => removeSelection(store, selector, { confirmedProfileRemoval: true }));
		if (result.action === "profile-removed") notifyRemoved(ctx, result.label, result.droppedAliases);
		return;
	}
	if (pre.action === "alias-removed") {
		ctx.ui.notify(`seat: removed alias "${pre.alias}" (profile "${pre.target}" kept)`, "info");
	} else if (pre.action === "profile-removed") {
		notifyRemoved(ctx, pre.label, pre.droppedAliases);
	}
}

function notifyRemoved(ctx: ExtensionCommandContext, label: string, droppedAliases: string[]): void {
	ctx.ui.notify(
		`seat: removed profile "${label}"${droppedAliases.length > 0 ? ` and aliases ${droppedAliases.join(", ")}` : ""}`,
		"info",
	);
}

async function handleRename(rest: string[], ctx: ExtensionCommandContext, deps: SeatCommandDeps): Promise<void> {
	const [oldSelector, newLabel, ...extra] = rest;
	if (oldSelector === undefined || newLabel === undefined || extra.length > 0) {
		throw new CommandError("usage: /seat rename <old-selector> <new-label>");
	}
	const result = runMutation(deps.backend, (store) => renameProfile(store, oldSelector, newLabel));
	ctx.ui.notify(
		`seat: renamed "${result.from}" to "${result.to}"${result.retargetedAliases.length > 0 ? ` (aliases ${result.retargetedAliases.join(", ")} follow)` : ""}`,
		"info",
	);
}

function parseLoginArgs(rest: string[]): { selector: string; aliases: string[] } {
	let selector: string | undefined;
	const aliases: string[] = [];
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i]!;
		if (token === "-a" || token === "--alias") {
			const value = rest[i + 1];
			if (value === undefined) throw new CommandError(`${token} needs a value`);
			aliases.push(value);
			i += 1;
		} else if (selector === undefined) {
			selector = token;
		} else {
			throw new CommandError("usage: /seat login <selector> [-a <alias>]…");
		}
	}
	if (selector === undefined) throw new CommandError("usage: /seat login <selector> [-a <alias>]…");
	return { selector, aliases };
}

function buildInteraction(ctx: ExtensionCommandContext, signal: AbortSignal): ProviderAuthInteraction {
	return {
		signal,
		prompt: async (prompt: AuthPrompt): Promise<string> => {
			if (prompt.type === "select") {
				const selected = await ctx.ui.select(prompt.message, prompt.options.map((o) => o.label));
				const id = prompt.options.find((o) => o.label === selected)?.id;
				if (id === undefined) throw new CommandError("login cancelled");
				return id;
			}
			const value = await ctx.ui.input(prompt.message, prompt.placeholder ?? "");
			if (value === undefined) throw new CommandError("login cancelled");
			return value;
		},
		notify: (event) => {
			switch (event.type) {
				case "auth_url":
					ctx.ui.notify([`Open this URL to login:`, event.url, event.instructions].filter(Boolean).join("\n"), "info");
					break;
				case "device_code":
					ctx.ui.notify([`Open ${event.verificationUri} and enter code: ${event.userCode}`].join("\n"), "info");
					break;
				case "info":
					ctx.ui.notify([event.message, ...(event.links ?? []).map((l) => l.url)].join("\n"), "info");
					break;
				case "progress":
					ctx.ui.notify(event.message, "info");
					break;
			}
		},
	};
}

function statusText(deps: SeatCommandDeps): string {
	const store = deps.backend.read((current) => decodeStore(current));
	const lines: string[] = [];
	for (const adapter of deps.adapters) {
		const pin = deps.pins[adapter.id];
		const selection = resolveSelection(store, adapter.id, pin);
		const detail =
			selection.source === "builtin"
				? "Pi built-in login"
				: `${selection.label} (${selection.source})`;
		lines.push(`${adapter.id}: ${detail}`);
	}
	return `seat status\n${lines.join("\n")}`;
}
