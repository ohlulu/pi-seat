/**
 * seat CLI entry (REQ-003, REQ-006, REQ-007).
 *
 * Synopsis (Python-compatible):
 *   seat                                usage (default)
 *   seat usage [--json]
 *   seat status [--plain]               --plain: Anthropic-only 4-col TSV
 *   seat whoami [--plain]               offline: default + pin per provider
 *   seat use <selector> | seat <selector>
 *   seat login <selector> [-a|--alias <alias>]…
 *   seat rm <selector> [--force|--no-input]
 *   seat rename <old-selector> <new-label>
 *
 * I/O contract: primary output on stdout only; diagnostics and prompts on
 * stderr only. Exit codes: 0 ok, 1 operation failure, 2 bad invocation.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { PROVIDER_IDS, type ProviderId, type SeatStore } from "../store/schema.ts";
import { FileSeatStorageBackend, decodeStore, type SeatStorageBackend } from "../store/storage.ts";
import { SelectorError, parseSelector, resolvePins, resolveSelection } from "../store/selector.ts";
import { CommandError, loginProfile, removeSelection, renameProfile, runMutation, useSelection } from "../extension/commands.ts";
import { adapterFor, createSeatProviderAdapters, toRefreshCallback, type SeatProviderAdapter } from "../extension/oauth.ts";
import { builtinUsage, profileUsage, type UsageFetchOptions } from "../usage/fetch.ts";
import { planLayout } from "../usage/layout.ts";
import { accountLine, hintLine, renderClaudeUsage, renderCodexUsage, type ClaudeUsage, type CodexUsage, type RenderOptions } from "../usage/render.ts";

export const VERSION = "3.0.0";
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

export interface CliIo {
	out(line: string): void;
	err(line: string): void;
	/** Interactive yes/no; CLI prompts land on stderr only. */
	confirm(question: string): Promise<boolean>;
	/** Free-text prompt for OAuth interactions (manual code paste). */
	input(question: string): Promise<string | undefined>;
}

export interface CliDeps {
	backend: SeatStorageBackend;
	adapters: SeatProviderAdapter[];
	authPath: string;
	env: Record<string, string | undefined>;
	io: CliIo;
	termWidth: number;
	color: boolean;
	fetchOptions?: UsageFetchOptions;
	now?: () => Date;
}

export function defaultDeps(): CliDeps {
	const agentDir =
		process.env["PI_CODING_AGENT_DIR"] !== undefined && process.env["PI_CODING_AGENT_DIR"] !== ""
			? process.env["PI_CODING_AGENT_DIR"]
			: join(homedir(), ".pi", "agent");
	return {
		backend: new FileSeatStorageBackend(join(agentDir, "seat.json")),
		adapters: createSeatProviderAdapters(),
		authPath: join(agentDir, "auth.json"),
		env: process.env,
		io: {
			out: (line) => console.log(line),
			err: (line) => console.error(line),
			confirm: async (question) => {
				process.stderr.write(`${question} [y/N] `);
				const answer = await readStdinLine();
				return answer !== undefined && /^y(es)?$/i.test(answer.trim());
			},
			input: async (question) => {
				process.stderr.write(`${question}: `);
				return readStdinLine();
			},
		},
		termWidth: process.stdout.columns || Number(process.env["COLUMNS"]) || 80,
		color: Boolean(process.stdout.isTTY) && process.env["NO_COLOR"] === undefined,
	};
}

async function readStdinLine(): Promise<string | undefined> {
	for await (const line of console) return line;
	return undefined;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	const [head, ...rest] = argv;
	try {
		if (head === undefined) return await cmdUsage([], deps);
		switch (head) {
			case "-h":
			case "--help":
			case "help":
				printHelp(deps.io);
				return EXIT_OK;
			case "--version":
				deps.io.out(`seat ${VERSION}`);
				return EXIT_OK;
			case "usage":
				return await cmdUsage(rest, deps);
			case "status":
				return cmdStatus(rest, deps);
			case "whoami":
				return cmdWhoami(rest, deps);
			case "use":
				return requireArgs(rest, 1, "usage: seat use <selector>", deps) ?? cmdUse(rest[0]!, deps);
			case "login":
				return await cmdLogin(rest, deps);
			case "rm":
				return await cmdRm(rest, deps);
			case "rename":
				return requireArgs(rest, 2, "usage: seat rename <old-selector> <new-label>", deps) ?? cmdRename(rest[0]!, rest[1]!, deps);
			default:
				if (head.startsWith("-")) return usageError(`unknown option "${head}"`, deps);
				if (rest.length > 0) return usageError("usage: seat <selector>", deps);
				return cmdUse(head, deps); // bare shorthand ≡ use
		}
	} catch (error) {
		if (error instanceof UsageInvocationError) {
			deps.io.err(`seat: ${error.message}`);
			return EXIT_USAGE;
		}
		if (error instanceof CommandError || error instanceof SelectorError) {
			deps.io.err(`seat: ${error.message}`);
			return EXIT_FAIL;
		}
		deps.io.err(`seat: ${error instanceof Error ? error.message : String(error)}`);
		return EXIT_FAIL;
	}
}

class UsageInvocationError extends Error {}

function usageError(message: string, deps: CliDeps): number {
	deps.io.err(`seat: ${message}`);
	return EXIT_USAGE;
}

function requireArgs(rest: string[], count: number, message: string, deps: CliDeps): number | undefined {
	if (rest.length !== count) return usageError(message, deps);
	return undefined;
}

function printHelp(io: CliIo): void {
	io.out(
		[
			"usage:",
			"  seat                                   usage (shorthand)",
			"  seat <selector>                        switch default (shorthand)",
			"  seat use <selector>",
			"  seat login <selector> [-a <alias>]…",
			"  seat rm <selector> [--force|--no-input]",
			"  seat rename <old-selector> <new-label>",
			"  seat usage [--json]",
			"  seat status [--plain]",
			"  seat whoami [--plain]",
		].join("\n"),
	);
}

function loadStore(deps: CliDeps): SeatStore {
	return deps.backend.read((current) => decodeStore(current));
}

/** PI_SEAT pins for reporting. Read-only commands degrade to no-pin with a
 * diagnostic — the extension is where a bad pin fails the session closed. */
function reportingPins(store: SeatStore, deps: CliDeps): Partial<Record<ProviderId, string>> {
	try {
		return resolvePins(store, deps.env["PI_SEAT"] ?? "");
	} catch (error) {
		deps.io.err(`seat: ignoring invalid PI_SEAT — ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

// --- use / rename / rm / login ----------------------------------------------

function cmdUse(selector: string, deps: CliDeps): number {
	const result = runMutation(deps.backend, (store) => useSelection(store, selector));
	const pins = reportingPins(loadStore(deps), deps);
	const suffix = pins[result.provider] !== undefined ? ` — this session keeps its pin (${pins[result.provider]})` : "";
	if (result.action === "clear") deps.io.err(`seat: ${result.provider} default cleared; Pi built-in login applies${suffix}`);
	else deps.io.err(`seat: ${result.provider} default is now "${result.label}"${suffix}`);
	return EXIT_OK;
}

function cmdRename(oldSelector: string, newLabel: string, deps: CliDeps): number {
	const result = runMutation(deps.backend, (store) => renameProfile(store, oldSelector, newLabel));
	deps.io.err(
		`seat: renamed "${result.from}" to "${result.to}"${result.retargetedAliases.length > 0 ? ` (aliases ${result.retargetedAliases.join(", ")} follow)` : ""}`,
	);
	return EXIT_OK;
}

async function cmdRm(rest: string[], deps: CliDeps): Promise<number> {
	const flags = rest.filter((t) => t.startsWith("--"));
	const positional = rest.filter((t) => !t.startsWith("--"));
	for (const flag of flags) {
		if (flag !== "--force" && flag !== "--no-input") throw new UsageInvocationError(`unknown flag "${flag}"`);
	}
	if (positional.length !== 1) throw new UsageInvocationError("usage: seat rm <selector> [--force|--no-input]");
	const selector = positional[0]!;
	const force = flags.includes("--force");
	const noInput = flags.includes("--no-input");

	const pre = runMutation(deps.backend, (store) => removeSelection(store, selector, { confirmedProfileRemoval: force }));
	if (pre.action === "needs-confirm") {
		if (noInput) throw new CommandError(`removing profile "${pre.label}" needs confirmation; pass --force`);
		const ok = await deps.io.confirm(`Delete profile "${pre.label}" and its grant?`);
		if (!ok) {
			deps.io.err("seat: rm cancelled");
			return EXIT_FAIL;
		}
		const result = runMutation(deps.backend, (store) => removeSelection(store, selector, { confirmedProfileRemoval: true }));
		if (result.action === "profile-removed") deps.io.err(`seat: removed profile "${result.label}"`);
		return EXIT_OK;
	}
	if (pre.action === "alias-removed") deps.io.err(`seat: removed alias "${pre.alias}" (profile "${pre.target}" kept)`);
	else if (pre.action === "profile-removed") deps.io.err(`seat: removed profile "${pre.label}"`);
	return EXIT_OK;
}

async function cmdLogin(rest: string[], deps: CliDeps): Promise<number> {
	let selector: string | undefined;
	const aliases: string[] = [];
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i]!;
		if (token === "-a" || token === "--alias") {
			const value = rest[i + 1];
			if (value === undefined) throw new UsageInvocationError(`${token} needs a value`);
			aliases.push(value);
			i += 1;
		} else if (token.startsWith("-")) {
			throw new UsageInvocationError(`unknown flag "${token}"`);
		} else if (selector === undefined) {
			selector = token;
		} else {
			throw new UsageInvocationError("usage: seat login <selector> [-a <alias>]…");
		}
	}
	if (selector === undefined) throw new UsageInvocationError("usage: seat login <selector> [-a <alias>]…");

	const parsed = parseSelector(selector);
	const exists = deps.backend.read((current) => {
		const store = decodeStore(current);
		return Object.hasOwn(store.providers[parsed.provider]?.profiles ?? {}, parsed.name);
	});
	let confirmedOverwrite = false;
	if (exists) {
		const ok = await deps.io.confirm(`Profile "${parsed.name}" already exists. Overwrite its grant?`);
		if (!ok) {
			deps.io.err("seat: login cancelled; existing profile kept");
			return EXIT_FAIL;
		}
		confirmedOverwrite = true;
	}

	const adapter = adapterFor(deps.adapters, parsed.provider);
	const controller = new AbortController();
	const credential = await adapter.oauth.login({
		signal: controller.signal,
		prompt: async (prompt) => {
			if (prompt.type === "select") {
				for (const option of prompt.options) deps.io.err(`  ${option.id}: ${option.label}`);
				const answer = await deps.io.input(prompt.message);
				if (answer === undefined) throw new CommandError("login cancelled");
				return answer;
			}
			const answer = await deps.io.input(prompt.message);
			if (answer === undefined) throw new CommandError("login cancelled");
			return answer;
		},
		notify: (event) => {
			if (event.type === "auth_url") deps.io.err(`Open this URL to login:\n${event.url}`);
			else if (event.type === "device_code") deps.io.err(`Open ${event.verificationUri} and enter code: ${event.userCode}`);
			else if (event.type === "info") deps.io.err(event.message);
			else if (event.type === "progress") deps.io.err(event.message);
		},
	});

	const result = runMutation(deps.backend, (store) =>
		loginProfile(store, selector!, credential as never, aliases, { confirmedOverwrite }),
	);
	if (result.action !== "stored") throw new CommandError("login raced another mutation; try again");
	deps.io.err(`seat: stored ${result.provider} profile "${result.label}"${result.overwrote ? " (overwrote previous grant)" : ""}`);
	return EXIT_OK;
}

// --- status / whoami ---------------------------------------------------------

function cmdStatus(rest: string[], deps: CliDeps): number {
	const plain = rest.includes("--plain");
	const extra = rest.filter((t) => t !== "--plain");
	if (extra.length > 0) throw new UsageInvocationError("usage: seat status [--plain]");

	const store = loadStore(deps);
	const pins = reportingPins(store, deps);

	if (plain) {
		// Anthropic-only, exactly four tab-separated columns, no header.
		// `active` = this process's effective named selection (pin > default);
		// built-in login means no active row.
		const section = store.providers.anthropic;
		const selection = resolveSelection(store, "anthropic", pins.anthropic);
		const activeLabel = selection.source === "builtin" ? undefined : selection.label;
		for (const label of Object.keys(section?.profiles ?? {})) {
			const akas = Object.keys(section?.aliases ?? {})
				.filter((a) => section?.aliases[a] === label)
				.sort()
				.join(",");
			const expires = section?.profiles[label]?.expires;
			deps.io.out(
				[label, label === activeLabel ? "active" : "-", typeof expires === "number" ? String(expires) : "-", akas || "-"].join("\t"),
			);
		}
		return EXIT_OK;
	}

	for (const provider of PROVIDER_IDS) {
		const section = store.providers[provider];
		const selection = resolveSelection(store, provider, pins[provider]);
		const effective = selection.source === "builtin" ? "Pi built-in login" : `${selection.label} (${selection.source})`;
		deps.io.out(`${provider}: ${effective}`);
		for (const label of Object.keys(section?.profiles ?? {})) {
			const akas = Object.keys(section?.aliases ?? {})
				.filter((a) => section?.aliases[a] === label)
				.sort();
			deps.io.out(`  ${label}${akas.length > 0 ? ` (${akas.join(", ")})` : ""}`);
		}
	}
	return EXIT_OK;
}

function cmdWhoami(rest: string[], deps: CliDeps): number {
	const plain = rest.includes("--plain");
	const extra = rest.filter((t) => t !== "--plain");
	if (extra.length > 0) throw new UsageInvocationError("usage: seat whoami [--plain]");

	const store = loadStore(deps);
	const pins = reportingPins(store, deps);
	for (const provider of PROVIDER_IDS) {
		const def = store.providers[provider]?.default;
		const pin = pins[provider];
		if (plain) deps.io.out([provider, def ?? "-", pin ?? "-"].join("\t"));
		else deps.io.out(`${provider}: default=${def ?? "(none)"} pin=${pin ?? "(none)"}`);
	}
	return EXIT_OK;
}

// --- usage -------------------------------------------------------------------

async function cmdUsage(rest: string[], deps: CliDeps): Promise<number> {
	const asJson = rest.includes("--json");
	const extra = rest.filter((t) => t !== "--json");
	if (extra.length > 0) throw new UsageInvocationError("usage: seat usage [--json]");

	const store = loadStore(deps);
	const pins = reportingPins(store, deps);
	const layout = planLayout(deps.termWidth);
	const renderOptions: RenderOptions = { color: deps.color && !asJson, now: deps.now ?? (() => new Date()) };
	const fetchOptions = deps.fetchOptions ?? {};
	let failed = false;
	const json: Record<string, unknown> = {};

	const emit = (lines: string[]) => {
		if (!asJson) for (const line of lines) deps.io.out(line);
	};

	// Anthropic: every stored profile, then the built-in snapshot.
	const anthropicSection = store.providers.anthropic;
	const anthropicSelection = resolveSelection(store, "anthropic", pins.anthropic);
	const activeAnthropic = anthropicSelection.source === "builtin" ? null : anthropicSelection.label;
	const profileJson: Record<string, unknown> = {};
	for (const label of Object.keys(anthropicSection?.profiles ?? {})) {
		const akas = Object.keys(anthropicSection?.aliases ?? {})
			.filter((a) => anthropicSection?.aliases[a] === label)
			.sort();
		const adapter = adapterFor(deps.adapters, "anthropic");
		const result = await profileUsage(deps.backend, "anthropic", label, toRefreshCallback(adapter), fetchOptions);
		if (result.ok) {
			emit(["", accountLine(layout, label, akas, label === activeAnthropic, "", renderOptions)]);
			emit(renderClaudeUsage(layout, result.usage as ClaudeUsage, renderOptions));
			profileJson[label] = result.usage;
		} else {
			failed = true;
			if (asJson) deps.io.err(`seat: ${label}: unavailable — ${result.error}`);
			else {
				emit(["", accountLine(layout, label, akas, false, "unavailable", renderOptions)]);
				emit([hintLine(layout, result.error, renderOptions)]);
			}
		}
	}
	const anthropicBuiltin = await builtinUsage(deps.authPath, "anthropic", fetchOptions);
	if (anthropicBuiltin !== undefined) {
		const live = anthropicSelection.source === "builtin";
		if ("ok" in anthropicBuiltin && anthropicBuiltin.ok) {
			emit(["", accountLine(layout, "Claude", [], live, "built-in", renderOptions)]);
			emit(renderClaudeUsage(layout, anthropicBuiltin.usage as ClaudeUsage, renderOptions));
			json["anthropic-builtin"] = anthropicBuiltin.usage;
		} else if ("expired" in anthropicBuiltin) {
			emit(["", accountLine(layout, "Claude", [], live, "token expired", renderOptions)]);
			emit([hintLine(layout, "run pi once to refresh it — seat never touches Pi's grant", renderOptions)]);
		} else {
			failed = true;
			const message = "error" in anthropicBuiltin ? anthropicBuiltin.error : "unavailable";
			if (asJson) deps.io.err(`seat: built-in: unavailable — ${message}`);
			else {
				emit(["", accountLine(layout, "Claude", [], live, "unavailable", renderOptions)]);
				emit([hintLine(layout, message, renderOptions)]);
			}
		}
	}
	if (Object.keys(profileJson).length > 0 || activeAnthropic !== null) {
		json["anthropic"] = { active: activeAnthropic, profiles: profileJson };
	} else if (json["anthropic-builtin"] !== undefined) {
		json["anthropic"] = json["anthropic-builtin"];
		delete json["anthropic-builtin"];
	}

	// Codex: effective selection — a named profile, else the built-in snapshot.
	const codexSelection = resolveSelection(store, "openai-codex", pins["openai-codex"]);
	if (codexSelection.source !== "builtin") {
		const adapter = adapterFor(deps.adapters, "openai-codex");
		const result = await profileUsage(deps.backend, "openai-codex", codexSelection.label, toRefreshCallback(adapter), fetchOptions);
		if (result.ok) {
			const usage = result.usage as CodexUsage;
			emit(["", accountLine(layout, codexSelection.label, [], true, String(usage.plan_type ?? ""), renderOptions)]);
			emit(renderCodexUsage(layout, usage, renderOptions));
			json["openai-codex"] = usage;
		} else {
			failed = true;
			if (asJson) deps.io.err(`seat: ${codexSelection.label}: unavailable — ${result.error}`);
			else {
				emit(["", accountLine(layout, codexSelection.label, [], true, "unavailable", renderOptions)]);
				emit([hintLine(layout, result.error, renderOptions)]);
			}
		}
	} else {
		const codexBuiltin = await builtinUsage(deps.authPath, "openai-codex", fetchOptions);
		if (codexBuiltin !== undefined) {
			if ("ok" in codexBuiltin && codexBuiltin.ok) {
				const usage = codexBuiltin.usage as CodexUsage;
				emit(["", accountLine(layout, "Codex", [], true, String(usage.plan_type ?? ""), renderOptions)]);
				emit(renderCodexUsage(layout, usage, renderOptions));
				json["openai-codex"] = usage;
			} else if ("expired" in codexBuiltin) {
				failed = true;
				emit(["", accountLine(layout, "Codex", [], true, "token expired", renderOptions)]);
				emit([hintLine(layout, "run pi once to refresh it", renderOptions)]);
			} else {
				failed = true;
				const message = "error" in codexBuiltin ? codexBuiltin.error : "unavailable";
				if (asJson) deps.io.err(`seat: Codex: unavailable — ${message}`);
				else {
					emit(["", accountLine(layout, "Codex", [], true, "unavailable", renderOptions)]);
					emit([hintLine(layout, message, renderOptions)]);
				}
			}
		}
	}

	if (asJson) deps.io.out(JSON.stringify(json, null, 2));
	return failed ? EXIT_FAIL : EXIT_OK;
}

if (import.meta.main) {
	const code = await runCli(process.argv.slice(2), defaultDeps());
	process.exit(code);
}
