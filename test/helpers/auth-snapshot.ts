/**
 * AC-001 / sandbox-rule guard: assert that live Pi agent credential files are
 * byte-identical across a test run. Integration tests run under a synthetic
 * PI_CODING_AGENT_DIR; this helper watches the LIVE ~/.pi/agent files so any
 * accidental escape from the sandbox fails the suite loudly.
 */

import { afterAll, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LIVE_AGENT_DIR = join(homedir(), ".pi", "agent");

export const DEFAULT_GUARDED_FILES = [
	join(LIVE_AGENT_DIR, "auth.json"),
	join(LIVE_AGENT_DIR, "claude-profiles.json"),
	join(LIVE_AGENT_DIR, "seat.json"),
] as const;

/** path → file bytes, or null when the file does not exist. */
export type FileSnapshot = Map<string, Buffer | null>;

function readOrNull(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch {
		return null;
	}
}

export function snapshotFiles(paths: readonly string[] = DEFAULT_GUARDED_FILES): FileSnapshot {
	const snap: FileSnapshot = new Map();
	for (const path of paths) snap.set(path, readOrNull(path));
	return snap;
}

/** Throws with a per-file report when any guarded file changed. */
export function assertUnchanged(snapshot: FileSnapshot): void {
	const violations: string[] = [];
	for (const [path, before] of snapshot) {
		const after = readOrNull(path);
		if (before === null && after === null) continue;
		if (before === null) violations.push(`${path}: created during test run`);
		else if (after === null) violations.push(`${path}: deleted during test run`);
		else if (!before.equals(after)) violations.push(`${path}: bytes changed during test run`);
	}
	if (violations.length > 0) {
		throw new Error(`AC-001 violation — live credential files mutated:\n  ${violations.join("\n  ")}`);
	}
}

/**
 * Register a beforeAll/afterAll pair guarding the given files for the current
 * test scope. The bunfig preload calls this once for the whole run; individual
 * integration files may call it again for tighter locality.
 */
export function registerAuthSnapshotTeardown(paths: readonly string[] = DEFAULT_GUARDED_FILES): void {
	let snapshot: FileSnapshot | undefined;
	beforeAll(() => {
		snapshot = snapshotFiles(paths);
	});
	afterAll(() => {
		if (snapshot) assertUnchanged(snapshot);
	});
}
