/**
 * Google ID-token verification and the uploader whitelist (SPEC §15.4).
 *
 * Stateless by construction: no sessions, no cookies, no refresh logic. Every
 * request carries its own bearer token, which is verified from scratch against
 * the provider's JWKS (jose keeps that key set cached in memory between calls).
 *
 * The token itself is never logged, never echoed into an error message and
 * never stored. Only the verified email leaves this module.
 */

import type { FetchImplementation } from "jose";
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";

/** Google's OIDC discovery document, https://accounts.google.com/.well-known/openid-configuration */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
/** Google mints ID tokens with either spelling; both are legitimate. */
export const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

export interface AuthConfig {
  /** `GOOGLE_CLIENT_ID`; the token's `aud` must equal this exactly. */
  clientId: string;
  /** Accepted `iss` values. Defaults to `GOOGLE_ISSUERS`; `OIDC_ISSUER` replaces them. */
  issuers: string[];
  /** `OIDC_JWKS_URL`, defaulting to `GOOGLE_JWKS_URL`. */
  jwksUrl: string;
  /** Lowercased `ALLOWED_EMAILS` entries: `"user@example.com"` or `"@example.com"`. */
  allowedEmails: string[];
}

export type AuthResult =
  | { ok: true; email: string }
  /** 401 bad/expired token, 403 valid token but not whitelisted, 503 provider unreachable. */
  | { ok: false; status: 401 | 403 | 503; error: string };

export interface Authenticator {
  /** Takes the raw `Authorization` header value (or null when absent). */
  authenticate(authorization: string | null): Promise<AuthResult>;
}

export function createAuthenticator(config: AuthConfig): Authenticator {
  // jose refetches the key set on an unknown `kid` (rate-limited by its own
  // cooldown) and otherwise reuses it for `cacheMaxAge`, so a signing-key
  // rotation at Google heals without a redeploy.
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), { [customFetch]: jwksFetch });

  return {
    async authenticate(authorization: string | null): Promise<AuthResult> {
      const token = bearerToken(authorization);
      if (token === null) {
        return { ok: false, status: 401, error: "Missing Authorization: Bearer <Google ID token>." };
      }

      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          // RS256 only. Without this, a token could name any algorithm the
          // resolved key happens to support.
          algorithms: ["RS256"],
          issuer: config.issuers,
          audience: config.clientId,
          // `exp` and `nbf` are enforced when present; requiring `exp` closes
          // the "no expiry claim, no expiry check" gap.
          requiredClaims: ["exp"],
        }));
      } catch (err) {
        return verifyFailure(err);
      }

      if (payload["email_verified"] !== true) {
        return { ok: false, status: 401, error: "The Google account's email address is not verified." };
      }
      const claimed = payload["email"];
      if (typeof claimed !== "string" || claimed.trim() === "") {
        return { ok: false, status: 401, error: "The token carries no email address." };
      }

      const email = claimed.trim().toLowerCase();
      if (!isEmailAllowed(email, config.allowedEmails)) {
        return { ok: false, status: 403, error: `${email} is not on this gateway's upload whitelist.` };
      }
      return { ok: true, email };
    },
  };
}

/** `Bearer <token>`, scheme case-insensitive per RFC 6750. Returns null if absent or malformed. */
function bearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer +([^\s]+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

/** The key set could not be obtained. Distinct from "this token is bad" — see `jwksFetch`. */
class JwksUnavailableError extends Error {}

/**
 * Fetches the key set, keeping a failure of the provider distinguishable from a
 * failure of the token. jose reports a JWKS endpoint that answered 500 — or a
 * redirect, or a proxy's HTML error page — as a bare `JOSEError`, the same type
 * it uses for "unexpected \"iss\" claim value". Read as a 401, that would tell
 * the client (SPEC §15.5) its token is stale, and it would silently re-sign-in in
 * a loop for the length of a Google outage. So the response is judged here,
 * before jose ever sees it: anything that is not a parseable key set is a 503.
 *
 * Network errors and jose's own request timeout need nothing extra — they already
 * arrive as a non-`JOSEError` or a `JWKSTimeout`, which `verifyFailure` maps to
 * 503 as well.
 */
const jwksFetch: FetchImplementation = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status !== 200) {
    throw new JwksUnavailableError(`the key set endpoint answered ${response.status}`);
  }
  const body = await response.text();
  try {
    JSON.parse(body);
  } catch {
    throw new JwksUnavailableError("the key set endpoint did not answer with JSON");
  }
  // Re-served rather than passed through: the body is already consumed, and jose
  // must see the exact bytes that just parsed.
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
};

/**
 * jose's messages ("unexpected \"iss\" claim value", "signature verification
 * failed", …) name the failed check without quoting any part of the token, so
 * they are safe to hand back and save operators a lot of guessing.
 */
function verifyFailure(err: unknown): AuthResult {
  // A key set we could not fetch, a request that timed out, or anything that is
  // not jose judging the token at all, is the provider's failure and not the
  // caller's — 503, never 401, so the client does not read it as a stale token.
  const unreachable =
    err instanceof JwksUnavailableError ||
    err instanceof errors.JWKSTimeout ||
    !(err instanceof errors.JOSEError);
  if (unreachable) {
    return {
      ok: false,
      status: 503,
      error: "Could not reach the identity provider's key set to verify the token.",
    };
  }
  return { ok: false, status: 401, error: `Invalid Google ID token: ${err.message}` };
}

/**
 * Whitelist match (SPEC §15.2): an entry is either a full address or an
 * `@domain.com` suffix. `allowed` is expected lowercased (see
 * `parseAllowedEmails`); `email` is lowercased by the caller.
 */
export function isEmailAllowed(email: string, allowed: string[]): boolean {
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? "" : email.slice(at);
  return allowed.some((entry) => (entry.startsWith("@") ? entry === domain : entry === email));
}

/**
 * Splits `ALLOWED_EMAILS`. Entries without an `@` are rejected rather than
 * silently ignored: `example.com` looks like it should work, matches nothing,
 * and would leave an operator convinced the gateway is broken. An empty list is
 * rejected too — a gateway nobody may upload through is a misconfiguration, and
 * the alternative reading (empty means everyone) must never be possible.
 *
 * The thrown message reaches unauthenticated callers (a misconfigured gateway
 * answers 500 with it), so it names the variable and never an entry. The
 * offending entries — real email addresses — go in `cause`, which only the
 * server-side log reads.
 */
export function parseAllowedEmails(raw: string | undefined): string[] {
  const entries = splitList(raw).map((entry) => entry.toLowerCase());
  if (entries.length === 0) {
    throw new Error("ALLOWED_EMAILS is empty; list at least one address or @domain.");
  }
  const bad = entries.filter((entry) => !entry.includes("@") || entry.endsWith("@"));
  if (bad.length > 0) {
    throw new Error("ALLOWED_EMAILS entries must be a full address or an @domain suffix.", {
      cause: `rejected ${bad.length} entry/entries: ${bad.join(", ")}`,
    });
  }
  return entries;
}

export function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}
