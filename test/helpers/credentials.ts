import type { SeatCredential, SeatOAuthCredential } from "../../src/store/schema.ts";

/** Narrow a stored credential to an OAuth grant; a test reading OAuth fields off an API key is a test bug. */
export function asOAuth(credential: SeatCredential | undefined): SeatOAuthCredential | undefined {
	if (credential === undefined) return undefined;
	if (credential.type !== "oauth") throw new Error(`expected an oauth credential, got ${credential.type}`);
	return credential;
}
