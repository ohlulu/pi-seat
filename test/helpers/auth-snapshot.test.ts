import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUnchanged, snapshotFiles } from "./auth-snapshot.ts";

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "seat-snap-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("auth snapshot helper (self-test)", () => {
	test("unchanged files pass", () => {
		withTempDir((dir) => {
			const file = join(dir, "auth.json");
			writeFileSync(file, `{"a":1}`);
			const snap = snapshotFiles([file]);
			expect(() => assertUnchanged(snap)).not.toThrow();
		});
	});

	test("a single byte change is detected", () => {
		withTempDir((dir) => {
			const file = join(dir, "auth.json");
			writeFileSync(file, `{"a":1}`);
			const snap = snapshotFiles([file]);
			writeFileSync(file, `{"a":2}`);
			expect(() => assertUnchanged(snap)).toThrow(/bytes changed/);
		});
	});

	test("same content rewritten (mtime bump only) still passes — byte comparison, not stat", () => {
		withTempDir((dir) => {
			const file = join(dir, "auth.json");
			writeFileSync(file, `{"a":1}`);
			const snap = snapshotFiles([file]);
			writeFileSync(file, `{"a":1}`);
			expect(() => assertUnchanged(snap)).not.toThrow();
		});
	});

	test("file creation where none existed is detected", () => {
		withTempDir((dir) => {
			const file = join(dir, "seat.json");
			const snap = snapshotFiles([file]);
			writeFileSync(file, `{}`);
			expect(() => assertUnchanged(snap)).toThrow(/created/);
		});
	});

	test("file deletion is detected", () => {
		withTempDir((dir) => {
			const file = join(dir, "auth.json");
			writeFileSync(file, `{"a":1}`);
			const snap = snapshotFiles([file]);
			unlinkSync(file);
			expect(() => assertUnchanged(snap)).toThrow(/deleted/);
		});
	});

	test("missing before and after passes", () => {
		withTempDir((dir) => {
			const snap = snapshotFiles([join(dir, "never-exists.json")]);
			expect(() => assertUnchanged(snap)).not.toThrow();
		});
	});

	test("report names every violated file", () => {
		withTempDir((dir) => {
			const a = join(dir, "a.json");
			const b = join(dir, "b.json");
			writeFileSync(a, "1");
			writeFileSync(b, "1");
			const snap = snapshotFiles([a, b]);
			writeFileSync(a, "2");
			writeFileSync(b, "2");
			try {
				assertUnchanged(snap);
				throw new Error("expected assertUnchanged to throw");
			} catch (error) {
				const message = (error as Error).message;
				expect(message).toContain("a.json");
				expect(message).toContain("b.json");
			}
		});
	});
});
