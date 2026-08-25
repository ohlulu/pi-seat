#!/usr/bin/env bun
/**
 * One-time legacy migration entry point (REQ-008, AC-014).
 *
 *   bun scripts/migrate-legacy.ts              # dry run: explain, write nothing
 *   bun scripts/migrate-legacy.ts --apply      # execute, under the store lock
 *   bun scripts/migrate-legacy.ts --dir <path> # override PI_CODING_AGENT_DIR
 *
 * Importing claude-profiles.json is a one-machine, one-time operator action,
 * so it is a command the operator runs at cutover — not something an extension
 * does behind a session's back on first load (AC-020).
 *
 * The rules live in src/store/migrate.ts and are not restated here. The dry run
 * gets its plan by running that same function against an in-memory copy of the
 * current store: identical decisions, identical reporting, and the only thing
 * the "write" lands in is a string in this process. auth.json and
 * claude-profiles.json are read-only on both paths.
 *
 * Exit codes: 0 executed or nothing to do, 1 fail-closed (import refused),
 * 2 bad invocation.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { migrateLegacyProfiles, type ExclusionRule, type MigrationResult } from "../src/store/migrate.ts";
import { FileSeatStorageBackend, InMemorySeatStorageBackend } from "../src/store/storage.ts";

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;

export interface MigrateScriptIo {
	out(line: string): void;
	err(line: string): void;
}

export interface MigrateScriptDeps {
	io: MigrateScriptIo;
	env: Record<string, string | undefined>;
	home: string;
}

const RULE_TEXT: Record<ExclusionRule, string> = {
	// Rule 1 (REQ-008): Pi rotates refresh tokens, so an already-rotated active
	// lineage cannot be recognized by comparing bytes — it is always excluded.
	"active-lineage": "legacy `active` lineage (Pi's built-in login owns this grant)",
	// Rule 2: the token still byte-matches auth.json's current credential.
	"builtin-grant": "shares auth.json's current anthropic grant",
};

const USAGE = "usage: bun scripts/migrate-legacy.ts [--apply] [--dir <agent-dir>]";

export function defaultDeps(): MigrateScriptDeps {
	return {
		io: { out: (line) => console.log(line), err: (line) => console.error(line) },
		env: process.env,
		home: homedir(),
	};
}

interface Args {
	apply: boolean;
	dir: string | undefined;
}

function parseArgs(argv: string[]): Args | { error: string } {
	const args: Args = { apply: false, dir: undefined };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i]!;
		if (token === "--apply") args.apply = true;
		else if (token === "--dir") {
			const value = argv[i + 1];
			if (value === undefined) return { error: "--dir needs a value" };
			args.dir = value;
			i += 1;
		} else if (token === "-h" || token === "--help") return { error: USAGE };
		else return { error: `unexpected argument "${token}"` };
	}
	return args;
}

export function runMigrateScript(argv: string[], deps: MigrateScriptDeps = defaultDeps()): number {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		deps.io.err(`migrate-legacy: ${parsed.error}`);
		if (parsed.error !== USAGE) deps.io.err(USAGE);
		return EXIT_USAGE;
	}

	const envDir = deps.env["PI_CODING_AGENT_DIR"];
	const base = parsed.dir ?? (envDir !== undefined && envDir.length > 0 ? envDir : join(deps.home, ".pi", "agent"));
	const storePath = join(base, "seat.json");
	const legacyPath = join(base, "claude-profiles.json");
	const authPath = join(base, "auth.json");

	deps.io.out(parsed.apply ? "seat migration (apply)" : "seat migration (dry run — nothing is written)");
	deps.io.out(`  store:  ${storePath}`);
	deps.io.out(`  legacy: ${legacyPath}`);
	deps.io.out(`  auth:   ${authPath}`);
	deps.io.out("");

	const result = parsed.apply
		? migrateLegacyProfiles({ backend: new FileSeatStorageBackend(storePath), legacyPath, authPath })
		: previewMigration(storePath, legacyPath, authPath);

	return report(result, parsed.apply, deps.io);
}

/**
 * Run the real decision against a copy of the store held in memory. The lock is
 * not taken: a preview cannot promise anything about a store another process is
 * writing, and taking a write lock to answer a question would block the very
 * session the operator is about to migrate.
 */
function previewMigration(storePath: string, legacyPath: string, authPath: string): MigrationResult {
	const current = new FileSeatStorageBackend(storePath).read((content) => content);
	const preview = new InMemorySeatStorageBackend();
	if (current !== undefined) preview.withLock(() => ({ result: undefined, next: current }));
	return migrateLegacyProfiles({ backend: preview, legacyPath, authPath });
}

function report(result: MigrationResult, apply: boolean, io: MigrateScriptIo): number {
	switch (result.outcome) {
		case "noop":
			io.out(`nothing to do: ${noopText(result.reason)}`);
			return EXIT_OK;

		case "fail-closed":
			io.err(`refused: ${result.reason}`);
			io.err("Nothing was imported. Run `/seat login <label>` once per account instead.");
			return EXIT_FAIL;

		case "imported": {
			const verb = apply ? "imported" : "would import";
			io.out(`${verb} (${result.imported.length}):`);
			for (const label of result.imported) io.out(`  ${label}`);
			if (result.imported.length === 0) io.out("  (none)");

			io.out("");
			io.out(`${apply ? "skipped" : "would skip"} (${result.excluded.length}):`);
			for (const entry of result.excluded) io.out(`  ${entry.label} — ${RULE_TEXT[entry.rule]}`);
			if (result.excluded.length === 0) io.out("  (none)");

			io.out("");
			if (apply) {
				io.out(result.notice);
			} else {
				io.out("Skipped accounts stay reachable through Pi's built-in login.");
				io.out("Run again with --apply to execute.");
			}
			return EXIT_OK;
		}
	}
}

function noopText(reason: "store-exists" | "legacy-absent" | "legacy-empty"): string {
	switch (reason) {
		case "store-exists":
			return "seat.json already exists — migration only ever runs into a fresh store";
		case "legacy-absent":
			return "no claude-profiles.json to import";
		case "legacy-empty":
			return "claude-profiles.json holds no profiles";
	}
}

if (import.meta.main) {
	process.exit(runMigrateScript(process.argv.slice(2)));
}
