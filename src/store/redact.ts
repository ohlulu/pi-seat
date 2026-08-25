/**
 * Token redaction for user-visible error text — vendored from pi-accounts
 * (MIT, see NOTICE), shared by the runtime coordinator and the usage fetch
 * path so no surface echoes credential material.
 */

export function redactTokenText(text: string, exactSecrets: readonly string[] = []): string {
	const secrets = [...new Set(exactSecrets.filter(Boolean))].sort((a, b) => b.length - a.length);
	const exact = secrets.length
		? new RegExp(secrets.map((secret) => escapeRegExp(secret)).join("|"), "g")
		: undefined;
	return (exact ? text.replace(exact, "<redacted>") : text)
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
		.replace(/"(access|refresh|access_token|refresh_token|token)"\s*:\s*"[^"]+"/gi, '"$1":"<redacted>"')
		.replace(/\b(access|refresh)[_-][A-Za-z0-9._~+/=-]+/gi, "$1-<redacted>");
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
