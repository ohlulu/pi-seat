/**
 * Per-request provider auth (AC-034) — the channel that carries seat into
 * pi-subagents foreground children.
 *
 * A foreground child runs on a fresh ModelRuntime with no extensions loaded,
 * so the per-turn overlay never reaches it. What it does inherit is every
 * provider the parent registered through `pi.registerProvider` — the same
 * object, closures included. Seat therefore registers each seat-managed
 * provider as a native Provider wrapping the one Pi already holds: models,
 * streaming, login and catalog refresh stay the base provider's; only auth
 * asks seat first, on every request.
 *
 * Pi resolves request auth with "a stored credential owns the provider"
 * (pi-ai `resolveProviderAuth`): an `auth.json` OAuth entry is refreshed under
 * Pi's own lock through `auth.oauth.refresh` and turned into request auth by
 * `auth.oauth.toAuth`; without one, `auth.apiKey.resolve` runs. The wrapper
 * hooks all three, so seat's credential wins on every path and Pi's
 * `auth.json` grant is never refreshed or written while seat owns the
 * provider. Unowned providers delegate untouched (AC-006).
 */

import type { ApiKeyAuth, ModelAuth, OAuthAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { PROVIDER_IDS, type ProviderId } from "../store/schema.ts";
import { SEAT_SENTINEL_API_KEY } from "./runtime-auth.ts";

/** What the registered provider asks seat on every request. */
export interface SeatAuthSource {
	/** True when seat owns the provider's auth. Throws seat's error when it cannot decide. */
	owns(provider: ProviderId): Promise<boolean>;
	/** Seat request auth; undefined when Pi's built-in login owns the provider. Throws to fail closed. */
	requestAuth(provider: ProviderId): Promise<ModelAuth | undefined>;
}

/** Status label Pi shows for seat-resolved auth. */
export const SEAT_AUTH_SOURCE = "pi-seat";

const WRAPPED = Symbol.for("pi-seat.wrapped-provider");

interface WrapInfo {
	base: Provider;
	/** Another extension's native provider that seat replaced; restored on uninstall. */
	restore: Provider | undefined;
}

function wrapInfo(provider: Provider | undefined): WrapInfo | undefined {
	if (!provider) return undefined;
	return (provider as unknown as Record<symbol, WrapInfo | undefined>)[WRAPPED];
}

export function wrapProvider(
	id: ProviderId,
	base: Provider,
	source: SeatAuthSource,
	restore: Provider | undefined = undefined,
): Provider {
	const baseOAuth = base.auth.oauth;
	const baseApiKey = base.auth.apiKey;

	const oauth: OAuthAuth | undefined = baseOAuth && {
		...baseOAuth,
		// Rest args: Pi 1.x passes login options that 0.84.x types do not declare.
		login: (...args: Parameters<OAuthAuth["login"]>) => baseOAuth.login(...args),
		refresh: async (credential, signal) => {
			// Pi calls this inside its auth.json lock. CredentialStore.modify reads
			// undefined as "leave the entry unchanged", so a seat-owned provider
			// never refreshes or rewrites Pi's grant; toAuth ignores it anyway.
			if (await source.owns(id)) return undefined as unknown as OAuthCredential;
			return baseOAuth.refresh(credential, signal);
		},
		toAuth: async (credential) => (await source.requestAuth(id)) ?? baseOAuth.toAuth(credential),
	};

	// Always present: an OAuth-only provider with no auth.json entry (Codex
	// logged in only through seat) reaches seat solely through this path.
	const apiKey: ApiKeyAuth = {
		name: baseApiKey?.name ?? base.name,
		...(baseApiKey?.login ? { login: (interaction) => baseApiKey.login!(interaction) } : {}),
		// Availability checks must not refresh tokens, so ownership answers them.
		check: async (input) => {
			// Installing the sentinel runs this check. It must pass without the
			// store, which may be the very thing that failed (AC-031/032); the
			// request itself still fails closed in resolve.
			if (input.credential?.key === SEAT_SENTINEL_API_KEY) return { type: "api_key", source: SEAT_AUTH_SOURCE };
			if (await source.owns(id)) return { type: "oauth", source: SEAT_AUTH_SOURCE };
			if (!baseApiKey) return undefined;
			if (baseApiKey.check) return baseApiKey.check(input);
			const resolved = await baseApiKey.resolve(input);
			return resolved ? { type: "api_key", ...(resolved.source ? { source: resolved.source } : {}) } : undefined;
		},
		resolve: async (input) => {
			const auth = await source.requestAuth(id);
			if (auth) return { auth, source: SEAT_AUTH_SOURCE };
			return baseApiKey?.resolve(input);
		},
	};

	const wrapper: Provider = { ...base, auth: { ...(oauth ? { oauth } : {}), apiKey } };
	Object.defineProperty(wrapper, WRAPPED, { value: { base, restore } satisfies WrapInfo });
	return wrapper;
}

/**
 * The slice of Pi's internal ModelRuntime seat needs to find the provider it
 * wraps. `builtins` is private (verified on Pi 0.84.2 and 1.2.0): it is the
 * instance Pi itself would use — remote-catalog wrapper included, models.json
 * overrides not yet applied, so they still compose once on top of seat.
 */
export interface ProviderHost {
	getRegisteredNativeProvider(id: string): Provider | undefined;
	getRegisteredProviderConfig(id: string): unknown;
	builtins: ReadonlyMap<string, Provider>;
}

/** Structural cast of ctx.modelRegistry.runtime; undefined when this Pi build lacks the slice. */
export function getProviderHost(modelRegistry: unknown): ProviderHost | undefined {
	if (!modelRegistry || typeof modelRegistry !== "object") return undefined;
	const runtime = (modelRegistry as { runtime?: unknown }).runtime;
	if (!runtime || typeof runtime !== "object") return undefined;
	const candidate = runtime as Record<string, unknown>;
	if (typeof candidate["getRegisteredNativeProvider"] !== "function") return undefined;
	if (typeof candidate["getRegisteredProviderConfig"] !== "function") return undefined;
	if (!(candidate["builtins"] instanceof Map)) return undefined;
	return runtime as unknown as ProviderHost;
}

/** The registration half of ExtensionAPI. */
export interface ProviderRegistrar {
	registerProvider(provider: Provider): void;
	unregisterProvider(name: string): void;
}

/**
 * Owns seat's provider registrations for one extension instance. Pi keeps
 * registered providers across `/reload`, so `uninstall` on session_shutdown
 * hands the id back — otherwise a stale wrapper would keep resolving through
 * a coordinator nobody drives, even with seat removed.
 */
export class SeatProviderInstaller {
	private readonly installed = new Map<ProviderId, { wrapper: Provider; restore: Provider | undefined }>();
	private host: ProviderHost | undefined;

	constructor(
		private readonly registrar: ProviderRegistrar,
		private readonly source: SeatAuthSource,
	) {}

	/** Register every seat-managed provider. Returns notices for providers seat could not wrap. */
	install(host: ProviderHost): string[] {
		this.host = host;
		const notices: string[] = [];
		for (const id of PROVIDER_IDS) {
			const current = host.getRegisteredNativeProvider(id);
			if (current !== undefined && current === this.installed.get(id)?.wrapper) continue;

			if (host.getRegisteredProviderConfig(id) !== undefined) {
				// A native registration would silently drop that extension's config.
				notices.push(
					`seat: another extension registered a provider config for "${id}"; seat cannot cover subagent children for ${id}; their auth comes from that config, not from seat.`,
				);
				continue;
			}

			// A wrapper left by an earlier instance (a shutdown that never ran) is
			// unwrapped, never wrapped twice.
			const stale = wrapInfo(current);
			const restore = stale ? stale.restore : current;
			const base = stale?.base ?? current ?? host.builtins.get(id);
			if (!base) continue;

			const wrapper = wrapProvider(id, base, this.source, restore);
			this.registrar.registerProvider(wrapper);
			this.installed.set(id, { wrapper, restore });
		}
		return notices;
	}

	uninstall(): void {
		const host = this.host;
		if (host) {
			for (const [id, { wrapper, restore }] of this.installed) {
				if (host.getRegisteredNativeProvider(id) !== wrapper) continue; // someone replaced it since
				if (restore) this.registrar.registerProvider(restore);
				else this.registrar.unregisterProvider(id);
			}
		}
		this.installed.clear();
		this.host = undefined;
	}
}
