/**
 * bunfig preload (T004): guard live ~/.pi/agent credential files for the whole
 * `bun test` run. Run-level beforeAll/afterAll cover every test file — the
 * test/integration/** files the sandbox rule targets included — so no
 * integration test can forget to register the AC-001 teardown.
 */
import { registerAuthSnapshotTeardown } from "./auth-snapshot.ts";

registerAuthSnapshotTeardown();
