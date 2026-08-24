/**
 * Provider OAuth adapters (REQ-004, REQ-005, REQ-007) — adapted from
 * pi-accounts oauth.ts (MIT, Copyright (c) 2026 narumiruna; see NOTICE).
 *
 * Reuses Pi's built-in provider OAuth implementations (login / refresh /
 * toAuth) for anthropic and openai-codex; seat never speaks the OAuth wire
 * protocols itself. The refresh side implements the T008 RefreshCallback
 * seam, translating provider errors into the persistent/transient taxonomy.
 */

import type { ModelAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ProviderId, SeatCredential } from "../store/schema.ts";
import { InvalidGrantError, type RefreshCallback } from "../store/refresh.ts";

export interface ProviderOwnedOAuth {
	login(interaction: ProviderAuthInteraction): Promise<OAuthCredential>;
	refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

export interface SeatProviderAdapter {
	id: ProviderId;
	displayName: string;
	oauth: ProviderOwnedOAuth;
}

type BuiltinProviderModule = {
	builtinProviders(): ReadonlyArray<{ id: string; auth: { oauth?: ProviderOwnedOAuth } }>;
};

export type ProviderModuleLoader = () => Promise<BuiltinProviderModule>;

const PROVIDERS_MODULE_ID = "@earendil-works/pi-ai/providers/all";

async function defaultProviderModuleLoader(): Promise<BuiltinProviderModule> {
	return (await import(PROVIDERS_MODULE_ID)) as BuiltinProviderModule;
}

/**
 * Build the two seat adapters. `loader` is a test seam; production uses Pi's
 * builtin provider registry. OAuth module resolution is lazy and memoized so
 * extension init stays cheap.
 */
export function createSeatProviderAdapters(loader: ProviderModuleLoader = defaultProviderModuleLoader): SeatProviderAdapter[] {
	const oauthPromises = new Map<ProviderId, Promise<ProviderOwnedOAuth>>();

	const lazy = (providerId: ProviderId): ProviderOwnedOAuth => {
		const load = (): Promise<ProviderOwnedOAuth> => {
			let promise = oauthPromises.get(providerId);
			if (!promise) {
				promise = loader().then((module) => {
					const oauth = module.builtinProviders().find((provider) => provider.id === providerId)?.auth.oauth;
					if (!oauth) throw new Error(`Pi's built-in ${providerId} OAuth provider is unavailable.`);
					return oauth;
				});
				oauthPromises.set(providerId, promise);
			}
			return promise;
		};
		return {
			login: async (interaction) => (await load()).login(interaction),
			refresh: async (credential, signal) => (await load()).refresh(credential, signal),
			toAuth: async (credential) => (await load()).toAuth(credential),
		};
	};

	return [
		{ id: "anthropic", displayName: "Anthropic", oauth: lazy("anthropic") },
		{ id: "openai-codex", displayName: "OpenAI Codex", oauth: lazy("openai-codex") },
	];
}

export function adapterFor(adapters: SeatProviderAdapter[], provider: ProviderId): SeatProviderAdapter {
	const adapter = adapters.find((candidate) => candidate.id === provider);
	if (!adapter) throw new Error(`no adapter for provider "${provider}"`);
	return adapter;
}

/**
 * Bridge a provider adapter into the T008 RefreshCallback seam. Provider
 * errors that name invalid_grant become InvalidGrantError (persistent,
 * fail-closed until re-login); everything else stays transient.
 */
export function toRefreshCallback(adapter: SeatProviderAdapter): RefreshCallback {
	return async (credential: SeatCredential, signal: AbortSignal): Promise<SeatCredential> => {
		let rotated: OAuthCredential;
		try {
			rotated = await adapter.oauth.refresh(asOAuthCredential(credential), signal);
		} catch (error) {
			if (isInvalidGrant(error)) {
				throw new InvalidGrantError(
					`${adapter.displayName} refused the refresh token (invalid_grant); run /seat login to mint a new grant`,
				);
			}
			throw error;
		}
		return asSeatCredential(rotated);
	};
}

/** SeatCredential and Pi's OAuthCredential are structurally identical. */
function asOAuthCredential(credential: SeatCredential): OAuthCredential {
	return credential as OAuthCredential;
}

function asSeatCredential(credential: OAuthCredential): SeatCredential {
	return credential as SeatCredential;
}

function isInvalidGrant(error: unknown): boolean {
	if (error instanceof InvalidGrantError) return true;
	if (!(error instanceof Error)) return false;
	return /invalid_grant/i.test(error.message);
}
