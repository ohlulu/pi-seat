/**
 * Anthropic Console API-key login (REQ-013, DEC-015), shared by `/seat login
 * --api-key` and `seat login --api-key`. Pi-free: the callers own how the key
 * is read; this module only decides whether it is worth storing.
 *
 * Two gates, both before the store is touched:
 *
 * - Shape. pi-ai treats any key containing `sk-ant-oat` as an OAuth token and
 *   sends it as a Bearer with Claude Code's identity, so an OAuth token pasted
 *   here would not bill the Console at all. Admin keys cannot call the
 *   Messages API. Every other `sk-ant-` shape (`sk-ant-api03-`, the newer
 *   `sk-ant-usr-`) is left to the live check rather than a whitelist.
 * - Live. One `GET /v1/models`: it costs no tokens and answers 401 for a
 *   mistyped or revoked key, which would otherwise surface on the first turn.
 *
 * No message produced here contains the key.
 */

import { acceptsApiKey, isWellFormedApiKey, type ProviderId, type SeatApiKeyCredential } from "../store/schema.ts";
import { redactTokenText } from "../store/redact.ts";
import { CommandError } from "./commands.ts";

export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";

/** `login` switches to the key flow on either spelling. */
export const API_KEY_FLAGS: readonly string[] = ["--api-key", "-k"];

/** Strip the key-flow flag from a `login` argument list. */
export function takeApiKeyFlag(tokens: readonly string[]): { apiKey: boolean; rest: string[] } {
	return {
		apiKey: tokens.some((token) => API_KEY_FLAGS.includes(token)),
		rest: tokens.filter((token) => !API_KEY_FLAGS.includes(token)),
	};
}

/** A token shaped like a provider secret (Anthropic `sk-ant-…`, or any long `sk-…`). */
export function looksLikeSecret(token: string): boolean {
	return token.startsWith("sk-ant-") || /^sk-[A-Za-z0-9_-]{20,}$/.test(token);
}

/**
 * Refuse a command line carrying a key, without echoing it. Every later error
 * path (usage text, "no profile or alias …") would otherwise print it back,
 * and by now it is already in the shell or Pi input history.
 */
export function assertNoSecretArguments(tokens: readonly string[]): void {
	if (!tokens.some(looksLikeSecret)) return;
	throw new CommandError(
		"a key was given on the command line; seat never takes a key as an argument. It may be in your shell or Pi input history now: revoke it in the Console, then run `login <label> --api-key` and paste the new key at the prompt",
	);
}
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const API_KEY_VERIFY_TIMEOUT_MS = 10_000;

export interface ApiKeyVerifyOptions {
	fetchImpl?: typeof fetch;
	url?: string;
	timeoutMs?: number;
	/** Called once the shape passed, right before the live request: the caller's progress line. */
	onVerifying?: () => void;
}

/** Why `key` cannot be an Anthropic Console API key, or undefined when its shape is acceptable. */
export function apiKeyShapeProblem(key: string): string | undefined {
	if (!isWellFormedApiKey(key)) return "the key is empty or contains whitespace";
	if (!key.startsWith("sk-ant-")) return 'an Anthropic API key starts with "sk-ant-"';
	if (key.includes("sk-ant-oat")) return "that is a Claude OAuth token, not a Console API key; use /seat login without --api-key";
	if (key.startsWith("sk-ant-admin")) return "that is an Admin API key, which cannot call the Messages API";
	return undefined;
}

/** The provider check, run before any key is read. */
export function assertApiKeyProvider(provider: ProviderId): void {
	if (!acceptsApiKey(provider)) {
		throw new CommandError(`${provider} profiles take OAuth only; --api-key is for anthropic`);
	}
}

/** Live check: one tokenless request that only a working key answers with 2xx. */
export async function verifyApiKey(key: string, options: ApiKeyVerifyOptions = {}): Promise<void> {
	const impl = options.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await impl(options.url ?? ANTHROPIC_MODELS_URL, {
			headers: {
				"x-api-key": key,
				"anthropic-version": ANTHROPIC_API_VERSION,
				Accept: "application/json",
				"User-Agent": "pi-seat",
			},
			signal: AbortSignal.timeout(options.timeoutMs ?? API_KEY_VERIFY_TIMEOUT_MS),
		});
	} catch (error) {
		const reason = redactTokenText(error instanceof Error ? error.message : String(error), [key]);
		throw new CommandError(`could not reach Anthropic to verify the key (${reason}); nothing stored`);
	}
	if (response.ok) return;
	const why =
		response.status === 401
			? "invalid or revoked"
			: response.status === 403
				? "not allowed to call the API"
				: response.statusText || "unexpected response";
	throw new CommandError(`Anthropic rejected the key (HTTP ${response.status}, ${why}); nothing stored`);
}

/** Shape check, then live check; the credential to store. Input is trimmed of surrounding whitespace. */
export async function apiKeyCredential(input: string, options: ApiKeyVerifyOptions = {}): Promise<SeatApiKeyCredential> {
	const key = input.trim();
	const problem = apiKeyShapeProblem(key);
	if (problem !== undefined) throw new CommandError(`${problem}; nothing stored`);
	options.onVerifying?.();
	await verifyApiKey(key, options);
	return { type: "api_key", key };
}
