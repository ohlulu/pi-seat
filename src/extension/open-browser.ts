/**
 * Best-effort platform browser launcher, adapted from pi-coding-agent's
 * dist/utils/open-browser.js (MIT — see NOTICE). Vendored because the upstream
 * path is internal API: a dist/ import would couple us to Pi's file layout.
 *
 * Never invokes a shell. On Windows, `cmd /c start` is forbidden: cmd.exe
 * re-parses metacharacters before `start` runs, making attacker-controlled
 * URLs injectable. Launch failures surface via the child's error event and are
 * swallowed — callers always present the URL too, so the flow never dies here.
 */

import { spawn } from "node:child_process";

export type BrowserOpener = (url: string) => void;

export const openBrowser: BrowserOpener = (url) => {
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", url]]
				: ["xdg-open", [url]];
	spawn(cmd, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
};
