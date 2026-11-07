/**
 * seat.json store schema v1 (docs/architecture.md DEC-003).
 *
 * Shape:
 *   { version: 1, providers: { <id>: { default?: label, profiles: { label: credential }, aliases: { alias: label } } } }
 *
 * A credential is an OAuth grant, or (anthropic only) a Console API key
 * (DEC-015, REQ-013). The API-key type is additive: the version stays 1.
 *
 * Labels and aliases are user input used as object keys, so parsing uses
 * own-property access only and all constructed maps are null-prototype —
 * a JSON document containing "__proto__" must never reach a prototype setter.
 */

export const PROVIDER_IDS = ["anthropic", "openai-codex"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
	return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Matches Pi's stored OAuthCredential (pi-ai auth/types). */
export interface SeatOAuthCredential {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

/** An Anthropic Console API key (REQ-013): no refresh, no expiry. */
export interface SeatApiKeyCredential {
	type: "api_key";
	key: string;
}

export type SeatCredential = SeatOAuthCredential | SeatApiKeyCredential;
export type SeatCredentialType = SeatCredential["type"];

/** Providers whose profiles may hold an API key; openai-codex takes OAuth only. */
export function acceptsApiKey(provider: ProviderId): boolean {
	return provider === "anthropic";
}

/**
 * The secret that identifies this credential: the grant's refresh token, or
 * the key itself. Used to bind confirmations and fail-closed blocks to one
 * concrete credential; never printed.
 */
export function credentialFingerprint(credential: SeatCredential): string {
	return credential.type === "oauth" ? credential.refresh : credential.key;
}

/** Every secret a credential carries, for exact-match redaction. */
export function credentialSecrets(credential: SeatCredential): string[] {
	return credential.type === "oauth" ? [credential.access, credential.refresh] : [credential.key];
}

export interface ProviderSection {
	default?: string;
	profiles: Record<string, SeatCredential>;
	aliases: Record<string, string>;
}

export interface SeatStore {
	version: 1;
	providers: Partial<Record<ProviderId, ProviderSection>>;
}

export class SchemaError extends Error {
	override name = "SchemaError";
}

/** Object-key names that would hit prototype machinery on plain objects. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Label/alias charset rule (REQ-002): `:` and `,` are selector metacharacters,
 * forbidden in labels and aliases. Enforced at parse and at login/rename.
 */
export function isValidLabel(label: string): boolean {
	if (label.length === 0) return false;
	if (label.includes(":") || label.includes(",")) return false;
	if (label !== label.trim()) return false;
	if (FORBIDDEN_KEYS.has(label)) return false;
	return true;
}

export function emptyStore(): SeatStore {
	return { version: 1, providers: nullProto({}) };
}

function nullProto<T extends object>(value: T): T {
	return Object.assign(Object.create(null) as T, value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own-property read that never walks the prototype chain. */
function own(obj: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function ownKeys(obj: Record<string, unknown>): string[] {
	return Object.keys(obj);
}

function parseCredential(raw: unknown, where: string, provider: ProviderId): SeatCredential {
	if (!isPlainObject(raw)) throw new SchemaError(`${where}: credential must be an object`);
	const type = own(raw, "type");
	if (type === "api_key") {
		if (!acceptsApiKey(provider)) throw new SchemaError(`${where}: provider "${provider}" does not accept api_key credentials`);
		return parseApiKeyCredential(raw, where);
	}
	if (type !== "oauth") throw new SchemaError(`${where}: credential.type must be "oauth" or "api_key"`);
	const refresh = own(raw, "refresh");
	const access = own(raw, "access");
	const expires = own(raw, "expires");
	if (typeof refresh !== "string" || refresh.length === 0) throw new SchemaError(`${where}: credential.refresh must be a non-empty string`);
	if (typeof access !== "string") throw new SchemaError(`${where}: credential.access must be a string`);
	if (typeof expires !== "number" || !Number.isFinite(expires)) throw new SchemaError(`${where}: credential.expires must be a finite number`);
	const cred = Object.create(null) as SeatOAuthCredential;
	for (const key of ownKeys(raw)) {
		if (FORBIDDEN_KEYS.has(key)) throw new SchemaError(`${where}: forbidden credential key "${key}"`);
		Object.defineProperty(cred, key, { value: raw[key], enumerable: true, writable: true, configurable: true });
	}
	return cred;
}

/** The key ends up in a request header, so whitespace and line breaks are refused here too. */
export function isWellFormedApiKey(key: string): boolean {
	return key.length > 0 && !/\s/.test(key);
}

function parseApiKeyCredential(raw: Record<string, unknown>, where: string): SeatApiKeyCredential {
	for (const key of ownKeys(raw)) {
		if (key !== "type" && key !== "key") throw new SchemaError(`${where}: unknown api_key credential key "${key}"`);
	}
	const key = own(raw, "key");
	if (typeof key !== "string" || !isWellFormedApiKey(key)) {
		throw new SchemaError(`${where}: credential.key must be a non-empty string without whitespace`);
	}
	return nullProto<SeatApiKeyCredential>({ type: "api_key", key });
}

function parseProviderSection(raw: unknown, provider: ProviderId): ProviderSection {
	if (!isPlainObject(raw)) throw new SchemaError(`providers.${provider} must be an object`);
	for (const key of ownKeys(raw)) {
		if (key !== "default" && key !== "profiles" && key !== "aliases") {
			throw new SchemaError(`providers.${provider}: unknown key "${key}"`);
		}
	}

	const profilesRaw = own(raw, "profiles");
	if (!isPlainObject(profilesRaw)) throw new SchemaError(`providers.${provider}.profiles must be an object`);
	const profiles = Object.create(null) as Record<string, SeatCredential>;
	for (const label of ownKeys(profilesRaw)) {
		if (!isValidLabel(label)) throw new SchemaError(`providers.${provider}: invalid profile label "${label}"`);
		Object.defineProperty(profiles, label, {
			value: parseCredential(profilesRaw[label], `providers.${provider}.profiles.${label}`, provider),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}

	const aliasesRaw = own(raw, "aliases") ?? {};
	if (!isPlainObject(aliasesRaw)) throw new SchemaError(`providers.${provider}.aliases must be an object`);
	const aliases = Object.create(null) as Record<string, string>;
	for (const alias of ownKeys(aliasesRaw)) {
		if (!isValidLabel(alias)) throw new SchemaError(`providers.${provider}: invalid alias "${alias}"`);
		const target = aliasesRaw[alias];
		if (typeof target !== "string") throw new SchemaError(`providers.${provider}.aliases.${alias}: target must be a string`);
		if (!Object.hasOwn(profiles, target)) throw new SchemaError(`providers.${provider}.aliases.${alias}: unknown target profile "${target}"`);
		if (Object.hasOwn(profiles, alias)) throw new SchemaError(`providers.${provider}.aliases.${alias}: alias collides with a profile label`);
		Object.defineProperty(aliases, alias, { value: target, enumerable: true, writable: true, configurable: true });
	}

	const section: ProviderSection = nullProto({ profiles, aliases });
	const def = own(raw, "default");
	if (def !== undefined) {
		if (typeof def !== "string") throw new SchemaError(`providers.${provider}.default must be a string`);
		if (!Object.hasOwn(profiles, def)) throw new SchemaError(`providers.${provider}.default: unknown profile "${def}"`);
		section.default = def;
	}
	return section;
}

/** Parse and validate an untrusted seat.json document. Throws SchemaError. */
export function parseStore(raw: unknown): SeatStore {
	if (!isPlainObject(raw)) throw new SchemaError("store must be an object");
	if (own(raw, "version") !== 1) throw new SchemaError("store.version must be 1");
	for (const key of ownKeys(raw)) {
		if (key !== "version" && key !== "providers") throw new SchemaError(`store: unknown key "${key}"`);
	}
	const providersRaw = own(raw, "providers");
	if (!isPlainObject(providersRaw)) throw new SchemaError("store.providers must be an object");

	const store = emptyStore();
	for (const provider of ownKeys(providersRaw)) {
		if (!isProviderId(provider)) throw new SchemaError(`store.providers: unknown provider "${provider}"`);
		store.providers[provider] = parseProviderSection(providersRaw[provider], provider);
	}
	return store;
}

/** Serialize for atomic write. Deterministic key order for byte-stable diffs. */
export function serializeStore(store: SeatStore): string {
	return `${JSON.stringify(store, null, "\t")}\n`;
}
