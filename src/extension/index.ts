/**
 * pi-seat extension entry (REQ-002, REQ-004).
 *
 * Loading never creates the store, never changes credential content, and
 * never runs a legacy import (AC-020). It is NOT literally side-effect-free:
 * the init-time read() takes a transient store lock and re-hardens an
 * existing seat.json to mode 0600 — deliberate defense in depth on a
 * credential file. The PI_SEAT pin is parsed once at setup (with aliases
 * resolved to labels) and is immutable for the session (DEC-002).
 *
 * Fail-closed wiring (AC-004): any PI_SEAT error — malformed, unknown
 * provider, duplicate provider, unknown label — records a startup error that
 * aborts every turn with an explicit notice, and applies no pin at all.
 * Missing runtime overlay support (Pi version incompatibility) aborts the same
 * way with a version notice.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "../store/schema.ts";
import { FileSeatStorageBackend } from "../store/storage.ts";
import { decodeStore } from "../store/storage.ts";
import { resolvePins } from "../store/selector.ts";
import { envUsageFetchOptions } from "../usage/fetch.ts";
import { createSeatProviderAdapters } from "./oauth.ts";
import { SeatRuntimeAuthCoordinator, getSeatRuntime } from "./runtime-auth.ts";
import { SEAT_COMMAND_DESCRIPTION, runSeatCommand } from "./seat-command.ts";

const PI_VERSION_NOTICE =
	"seat: this Pi version does not expose the runtime auth overlay (ModelRuntime.setRuntimeApiKey); " +
	"seat requires Pi >= 0.84.2. Provider turns are aborted until seat is disabled or Pi is upgraded.";

export function agentDir(env: Record<string, string | undefined> = process.env): string {
	const dir = env["PI_CODING_AGENT_DIR"];
	return dir !== undefined && dir.length > 0 ? dir : join(homedir(), ".pi", "agent");
}

export default function seatExtension(pi: ExtensionAPI): void {
	const base = agentDir();
	const backend = new FileSeatStorageBackend(join(base, "seat.json"));
	const authPath = join(base, "auth.json");
	const adapters = createSeatProviderAdapters();
	const fetchOptions = envUsageFetchOptions(process.env);

	const startupNotices: string[] = [];
	let startupError: string | undefined;
	let pins: Partial<Record<ProviderId, string>> = {};

	// Init-time pin parse (DEC-002): read PI_SEAT once, resolve aliases once.
	const pinSpec = process.env["PI_SEAT"] ?? "";
	try {
		pins = resolvePins(backend.read((current) => decodeStore(current)), pinSpec);
	} catch (error) {
		startupError = `seat: PI_SEAT is invalid — ${message(error)}. All seat-managed provider turns are aborted; fix PI_SEAT and restart.`;
		startupNotices.push(startupError);
	}

	pi.registerCommand("seat", {
		description: SEAT_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => runSeatCommand(args, ctx, { backend, adapters, pins, authPath, fetchOptions }),
	});

	let coordinator: SeatRuntimeAuthCoordinator | undefined;
	let noticesFlushed = false;

	pi.on("session_start", async (_event, ctx) => {
		if (noticesFlushed) return;
		noticesFlushed = true;
		for (const notice of startupNotices) notify(ctx, notice, startupError ? "error" : "info");
	});

	pi.on("turn_start", async (_event, ctx) => {
		// AC-004: never partial-apply — a bad pin spec aborts every provider turn.
		if (startupError !== undefined) {
			ctx.abort();
			notify(ctx, startupError, "error");
			return;
		}

		if (!coordinator) {
			const runtime = getSeatRuntime(ctx.modelRegistry);
			if (!runtime) {
				ctx.abort();
				notify(ctx, PI_VERSION_NOTICE, "error");
				return;
			}
			coordinator = new SeatRuntimeAuthCoordinator({ runtime, backend, adapters, pins });
		}

		await coordinator.syncTurn((reason) => {
			ctx.abort();
			notify(ctx, reason, "error");
		});
	});
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "error"): void {
	// ui.notify works in TUI and RPC alike (only ui.custom is TUI-only);
	// console.error is the fallback for anything without a notification channel.
	try {
		ctx.ui.notify(text, level);
	} catch {
		console.error(text);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
