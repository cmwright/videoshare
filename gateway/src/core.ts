/**
 * The whole gateway (SPEC §15.3): route, CORS, authenticate, presign.
 *
 * One `handleRequest(request, env)` runs unchanged as a Cloudflare Worker, a
 * Lambda behind a function URL, or a plain Node server — the adapters in
 * `worker.ts` / `lambda.ts` / `node.ts` only translate transport shapes.
 *
 * INVARIANT (SPEC §15): the gateway never proxies object bytes. It answers with
 * presigned URLs or with an error; there is no proxy mode and none may be
 * added. Nothing in this package fetches, streams or buffers bucket objects.
 */

import type { AuthConfig, Authenticator } from "./auth.ts";
import { GOOGLE_ISSUERS, GOOGLE_JWKS_URL, createAuthenticator, parseAllowedEmails, splitList } from "./auth.ts";
import type { BucketConfig, Presigner } from "./presign.ts";
import { createPresigner, parseSignRequest } from "./presign.ts";

/** Every adapter passes the same names (SPEC §15.2); Worker vars and `process.env` both fit. */
export interface GatewayEnv {
  BUCKET_ENDPOINT?: string | undefined;
  BUCKET_NAME?: string | undefined;
  BUCKET_REGION?: string | undefined;
  BUCKET_ACCESS_KEY_ID?: string | undefined;
  BUCKET_SECRET_ACCESS_KEY?: string | undefined;
  PUBLIC_BASE_URL?: string | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  ALLOWED_EMAILS?: string | undefined;
  ALLOWED_ORIGINS?: string | undefined;
  PRESIGN_EXPIRY_SECONDS?: string | undefined;
  /** Test-only overrides (SPEC §15.6); default to Google's. */
  OIDC_JWKS_URL?: string | undefined;
  OIDC_ISSUER?: string | undefined;
  [key: string]: string | undefined;
}

export interface GatewayConfig {
  publicBaseUrl: string;
  googleClientId: string;
  /** Exact origins allowed to call this gateway from a browser. Never contains `*`. */
  allowedOrigins: Set<string>;
  auth: AuthConfig;
  bucket: BucketConfig;
}

/**
 * Thrown by `readConfig`. `message` is public — a misconfigured gateway answers
 * 500 with it to anyone who asks — so it names the offending variable and never
 * its value. Anything that would quote a value (a whitelisted address, an origin)
 * goes in `detail`, which is only ever written to the server's own log.
 */
export class GatewayConfigError extends Error {
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) {
    super(message);
    this.detail = detail;
  }
}

export const DEFAULT_PRESIGN_EXPIRY_SECONDS = 900;
export const MAX_PRESIGN_EXPIRY_SECONDS = 3600;
/** A well-formed `/api/sign` body is a few hundred bytes; this is the ceiling. */
export const MAX_SIGN_BODY_BYTES = 16 * 1024;

export async function handleRequest(request: Request, env: GatewayEnv): Promise<Response> {
  let instance: Instance;
  try {
    instance = getInstance(env);
  } catch (err) {
    // No config means no ALLOWED_ORIGINS, so this one answer carries no CORS
    // headers. The message names an environment variable, never a value: an
    // unauthenticated caller must not be able to read the whitelist back out of
    // a broken deployment. `detail` — which may quote entries — stays in the log.
    const detail = err instanceof GatewayConfigError ? err.detail : undefined;
    console.error("[videoshare-gateway] misconfigured:", describe(err), detail ?? "");
    return jsonResponse({ error: `Gateway is misconfigured: ${describe(err)}` }, 500, {});
  }
  const { config } = instance;

  // Gateway-owned CORS. An Origin the operator did not list is refused outright
  // rather than served without the header: same outcome in a browser, but far
  // easier to diagnose, and it keeps unlisted sites from probing the gateway.
  const origin = request.headers.get("Origin");
  if (origin !== null && !config.allowedOrigins.has(origin)) {
    return jsonResponse({ error: `Origin ${origin} is not in ALLOWED_ORIGINS.` }, 403, {
      vary: "Origin",
    });
  }
  const cors = corsHeaders(origin);

  const route = routeOf(new URL(request.url).pathname);
  if (route === null) return jsonResponse({ error: "Not found." }, 404, cors);

  if (request.method === "OPTIONS") return preflightResponse(route, cors);

  try {
    if (route === "config") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed("GET, OPTIONS", cors);
      }
      return jsonResponse(
        {
          gateway: true,
          publicBaseUrl: config.publicBaseUrl,
          googleClientId: config.googleClientId,
        },
        200,
        cors,
      );
    }

    if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS", cors);
    return await handleSign(request, instance, cors);
  } catch (err) {
    console.error("[videoshare-gateway] unhandled error:", describe(err));
    return jsonResponse({ error: "The gateway failed to handle this request." }, 500, cors);
  }
}

// --- POST /api/sign ----------------------------------------------------------

async function handleSign(
  request: Request,
  instance: Instance,
  cors: Record<string, string>,
): Promise<Response> {
  // Authenticate before parsing: an unauthenticated caller learns nothing about
  // the request grammar, and no work is done on their behalf.
  const auth = await instance.authenticator.authenticate(request.headers.get("Authorization"));
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, cors);

  const text = await readBoundedText(request, MAX_SIGN_BODY_BYTES);
  if (text === null) return jsonResponse({ error: "Request body is too large." }, 413, cors);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "Body must be JSON." }, 400, cors);
  }

  const parsed = parseSignRequest(body);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400, cors);

  // Audit line, as SPEC §15.4 permits: the verified email and what it signed.
  // The bearer token is never logged, here or anywhere else.
  console.log(
    `[videoshare-gateway] sign op=${parsed.request.op} id=${parsed.request.id} email=${auth.email}`,
  );
  return jsonResponse(await instance.presigner.sign(parsed.request), 200, cors);
}

/**
 * The body, or null if it is over `limit` bytes.
 *
 * Counted in bytes and enforced while reading, which both matter: `request.text()`
 * buffers everything before anything can be checked, and a declared
 * `Content-Length` is optional — a chunked or HTTP/2 request has none. On a
 * Worker (no transport-level cap of its own, unlike `node.ts` and Lambda) those
 * two together let a whitelisted uploader decide how much memory the isolate
 * spends. Reading incrementally caps it at `limit` regardless of what arrives.
 */
async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) return null;

  const stream = request.body;
  if (stream === null) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return null; // the rest is dropped, never read
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Decoded once over the whole body, so a character split across two chunks
  // still decodes.
  return new TextDecoder().decode(bytes);
}

// --- Routing -----------------------------------------------------------------

type Route = "config" | "sign";

/**
 * `gatewayUrl` in the client's config may be an origin or a path prefix, and a
 * reverse proxy may or may not strip `/api`, so both mount points are accepted.
 * Nothing security-relevant hangs on this: `/api/sign` authenticates whichever
 * path reached it.
 */
function routeOf(pathname: string): Route | null {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === "/api/config" || path === "/config") return "config";
  if (path === "/api/sign" || path === "/sign") return "sign";
  return null;
}

// --- CORS --------------------------------------------------------------------

function corsHeaders(origin: string | null): Record<string, string> {
  // `Vary` even when nothing is echoed, so a shared cache never serves one
  // origin's answer (with its header) to another.
  const headers: Record<string, string> = { vary: "Origin" };
  if (origin !== null) headers["access-control-allow-origin"] = origin;
  return headers;
}

function preflightResponse(route: Route, cors: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "access-control-allow-methods": route === "config" ? "GET, OPTIONS" : "POST, OPTIONS",
      // Bearer tokens only — no cookies, so no Access-Control-Allow-Credentials.
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-max-age": "600",
      "cache-control": "no-store",
    },
  });
}

// --- Responses ---------------------------------------------------------------

function jsonResponse(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Presigned URLs are short-lived credentials; they must not sit in a cache.
      "cache-control": "no-store",
      ...cors,
    },
  });
}

function methodNotAllowed(allow: string, cors: Record<string, string>): Response {
  return jsonResponse({ error: `Method not allowed; use ${allow}.` }, 405, { ...cors, allow });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Configuration -----------------------------------------------------------

interface Instance {
  config: GatewayConfig;
  authenticator: Authenticator;
  presigner: Presigner;
}

/**
 * One instance per env object. A Worker isolate, a Lambda container and the Node
 * server each hold a single stable env object for their lifetime, so this keeps
 * the JWKS cache and the derived SigV4 signing key alive across requests without
 * ever caching across configurations — rotate a secret and the new process gets
 * a new object, hence a new instance.
 */
const instances = new WeakMap<GatewayEnv, Instance>();

function getInstance(env: GatewayEnv): Instance {
  const existing = instances.get(env);
  if (existing) return existing;

  const config = readConfig(env);
  const instance: Instance = {
    config,
    authenticator: createAuthenticator(config.auth),
    presigner: createPresigner(config.bucket),
  };
  instances.set(env, instance);
  return instance;
}

/**
 * Validates the whole environment (SPEC §15.2) or throws. Adapters that have a
 * startup phase (`node.ts`) call this at boot so a bad deployment fails loudly
 * instead of on the first upload.
 */
export function readConfig(env: GatewayEnv): GatewayConfig {
  const bucket: BucketConfig = {
    endpoint: readUrl(env, "BUCKET_ENDPOINT"),
    bucket: readBucketName(env),
    region: (env.BUCKET_REGION ?? "").trim() || "auto",
    accessKeyId: required(env, "BUCKET_ACCESS_KEY_ID"),
    secretAccessKey: required(env, "BUCKET_SECRET_ACCESS_KEY"),
    expirySeconds: readExpiry(env),
  };

  const auth: AuthConfig = {
    clientId: required(env, "GOOGLE_CLIENT_ID"),
    issuers: readIssuers(env),
    jwksUrl: env.OIDC_JWKS_URL?.trim() ? readUrl(env, "OIDC_JWKS_URL") : GOOGLE_JWKS_URL,
    allowedEmails: wrapConfigError("ALLOWED_EMAILS", () => parseAllowedEmails(env.ALLOWED_EMAILS)),
  };

  return {
    publicBaseUrl: readUrl(env, "PUBLIC_BASE_URL"),
    googleClientId: auth.clientId,
    allowedOrigins: readAllowedOrigins(env),
    auth,
    bucket,
  };
}

function required(env: GatewayEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new GatewayConfigError(`${name} is not set.`);
  return value;
}

/** Absolute http(s) URL with no query or fragment, trailing slashes trimmed. */
function readUrl(env: GatewayEnv, name: string): string {
  const raw = required(env, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayConfigError(`${name} must be an absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GatewayConfigError(`${name} must be http(s).`);
  }
  if (url.search || url.hash) {
    throw new GatewayConfigError(`${name} must not carry a query string or fragment.`);
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * The bucket name goes into the path of every signed URL, so it is pinned to the
 * S3 naming rules — a name with a `/` or `?` in it would change what is being
 * signed rather than just naming a bucket.
 */
function readBucketName(env: GatewayEnv): string {
  const name = required(env, "BUCKET_NAME");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(name)) {
    throw new GatewayConfigError(
      "BUCKET_NAME must be 3-63 characters of letters, digits, dot, dash or underscore.",
    );
  }
  return name;
}

function readExpiry(env: GatewayEnv): number {
  const raw = env.PRESIGN_EXPIRY_SECONDS?.trim();
  if (!raw) return DEFAULT_PRESIGN_EXPIRY_SECONDS;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PRESIGN_EXPIRY_SECONDS) {
    throw new GatewayConfigError(
      `PRESIGN_EXPIRY_SECONDS must be a whole number of seconds from 1 to ${MAX_PRESIGN_EXPIRY_SECONDS}.`,
    );
  }
  return seconds;
}

function readIssuers(env: GatewayEnv): string[] {
  const issuer = env.OIDC_ISSUER?.trim();
  return issuer ? [issuer] : [...GOOGLE_ISSUERS];
}

/**
 * `*` is rejected here rather than at request time (SPEC §15.2): a wildcard
 * would let any page on the internet spend this gateway's bucket credentials on
 * behalf of a signed-in user.
 */
function readAllowedOrigins(env: GatewayEnv): Set<string> {
  const entries = splitList(required(env, "ALLOWED_ORIGINS"));
  const origins = new Set<string>();
  for (const entry of entries) {
    if (entry === "*") {
      throw new GatewayConfigError(
        "ALLOWED_ORIGINS must not contain '*'; list each site origin explicitly.",
      );
    }
    let origin: string;
    try {
      origin = new URL(entry).origin;
    } catch {
      throw new GatewayConfigError(
        "ALLOWED_ORIGINS contains an entry that is not an absolute URL; each must be like https://videos.example.com.",
        `rejected entry: ${entry}`,
      );
    }
    if (origin === "null") {
      throw new GatewayConfigError(
        "ALLOWED_ORIGINS contains an entry with no usable origin.",
        `rejected entry: ${entry}`,
      );
    }
    origins.add(origin);
  }
  if (origins.size === 0) throw new GatewayConfigError("ALLOWED_ORIGINS is empty.");
  return origins;
}

/**
 * Adapts a validator that throws a plain `Error` (they live in modules that must
 * not depend on this one). By convention its `cause`, when a string, is the
 * log-only elaboration — see `parseAllowedEmails`.
 */
function wrapConfigError<T>(name: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    const detail = err instanceof Error && typeof err.cause === "string" ? err.cause : undefined;
    throw new GatewayConfigError(describe(err) || `${name} is invalid.`, detail);
  }
}
