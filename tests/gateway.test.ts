/**
 * Gateway unit tests (docs/SPEC.md §15.6).
 *
 * These drive `handleRequest()` — the one handler every adapter wraps — with
 * plain WHATWG `Request` objects, so nothing here depends on Workers, Lambda or
 * a listening socket.
 *
 * There is no test bypass in the gateway and none is wanted: the suite generates
 * a real RS256 key pair, serves a real JWKS from an in-process HTTP server,
 * points `OIDC_JWKS_URL`/`OIDC_ISSUER` at it, and mints real JWTs. Every
 * assertion below therefore runs the *production* verification path verbatim —
 * a token that this suite says is rejected is one Google's own tokens would be
 * checked against in the same way.
 *
 * The other invariant under test is the one that cannot be walked back
 * (SPEC §15): every URL the gateway hands out points at the *bucket*, never at
 * the gateway. The gateway signs; the bytes never touch it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleRequest, type GatewayEnv } from "../gateway/src/core";
import { randomId } from "../src/util";

// --- Fixtures ----------------------------------------------------------------

const CLIENT_ID = "1234567890-videoshare.apps.googleusercontent.com";
const ISSUER = "https://accounts.test.invalid";
const KID = "videoshare-test-key";

const BUCKET = "videoshare";
const ANALYTICS_BUCKET = "videoshare-analytics";
const BUCKET_ENDPOINT = "https://s3.example.com";
const ACCESS_KEY_ID = "AKIAEXAMPLEKEYID0000";
/** Must never appear in anything the gateway returns. */
const SECRET_ACCESS_KEY = "s3cr3tExampleSigningKeyDoNotLeakMe000000";

const SITE_ORIGIN = "https://videoshare.example.com";
const OTHER_ORIGIN = "https://also-mine.example.com";
const EVIL_ORIGIN = "https://evil.example.net";

/** One exact address and one `@domain` suffix, with the sloppy spacing a human would type. */
const ALLOWED_EMAILS = "alice@example.com, @team.example.com";
const ALLOWED_EMAIL = "alice@example.com";

const SIGN_URL = "https://gateway.example.com/api/sign";
const CONFIG_URL = "https://gateway.example.com/api/config";

/** A realistic S3/MinIO upload id: base64url-ish, opaque, no delimiters. */
const UPLOAD_ID = "ZjQxNzE5MTMtNDg4Ni00YjMwLTk1YWQtYzk0NGYzZWM3YWE2.x-1";

let signingKey: CryptoKey;
let publicJwk: JWK;
/** A second, unpublished key pair: valid RS256 signatures from the wrong signer. */
let strangerKey: CryptoKey;

let jwks: { keys: JWK[] } = { keys: [] };
let jwksServer: Server;
let jwksUrl: string;

// --- Stub bucket -------------------------------------------------------------

/**
 * A stand-in for the analytics bucket (SPEC §16.4), because the beacon endpoints
 * are the one place in this gateway that talks to storage itself. It is a real
 * socket, so the *whole* path runs: aws4fetch signs the request, Node's fetch
 * sends it, and what arrives here is exactly what an S3 implementation would see.
 * Nothing about it is mocked at the module boundary.
 */
interface BucketWrite {
  method: string;
  path: string;
  contentType: string | null;
  authorization: string | null;
  body: Buffer;
}

interface StoredObject {
  key: string;
  size: number;
  lastModified: string;
}

let bucketServer: Server;
let bucketEndpoint: string;
/** Every request the gateway made to the bucket, in order. */
let bucketWrites: BucketWrite[] = [];
/** What a listing answers with. */
let bucketObjects: StoredObject[] = [];
/** Non-null makes the bucket refuse everything with that status. */
let bucketFailure: number | null = null;
/** Keys per listing page, so pagination can be exercised without 1000-key pages. */
let bucketPageSize = 1000;

function resetBucket(): void {
  bucketWrites = [];
  bucketObjects = [];
  bucketFailure = null;
  bucketPageSize = 1000;
}

function listXml(prefix: string, start: number): string {
  const matching = bucketObjects.filter((object) => object.key.startsWith(prefix));
  const page = matching.slice(start, start + bucketPageSize);
  const more = matching.length > start + page.length;
  const contents = page
    .map(
      (object) =>
        `<Contents><Key>${object.key}</Key><LastModified>${object.lastModified}</LastModified>` +
        `<ETag>&quot;d41d8cd98f00b204e9800998ecf8427e&quot;</ETag><Size>${object.size}</Size>` +
        `<StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join("");
  const next = more
    ? `<NextContinuationToken>${Buffer.from(String(start + page.length)).toString("base64")}</NextContinuationToken>`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Name>${ANALYTICS_BUCKET}</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount>` +
    `<MaxKeys>${bucketPageSize}</MaxKeys><IsTruncated>${more}</IsTruncated>${contents}${next}` +
    `</ListBucketResult>`
  );
}

function serveBucket(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://bucket.invalid");
    bucketWrites.push({
      method: req.method ?? "GET",
      path: url.pathname,
      contentType: req.headers["content-type"] ?? null,
      authorization: req.headers["authorization"] ?? null,
      body: Buffer.concat(chunks),
    });

    if (bucketFailure !== null) {
      res.writeHead(bucketFailure, { "content-type": "application/xml" });
      res.end("<Error><Code>InternalError</Code><Message>nope</Message></Error>");
      return;
    }
    if (url.searchParams.get("list-type") === "2") {
      const token = url.searchParams.get("continuation-token");
      const start = token === null ? 0 : Number(Buffer.from(token, "base64").toString());
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(listXml(url.searchParams.get("prefix") ?? "", start));
      return;
    }
    res.writeHead(200, { etag: '"d41d8cd98f00b204e9800998ecf8427e"' });
    res.end();
  });
}

beforeAll(async () => {
  const real = await generateKeyPair("RS256", { extractable: true });
  const stranger = await generateKeyPair("RS256", { extractable: true });
  signingKey = real.privateKey;
  strangerKey = stranger.privateKey;
  publicJwk = { ...(await exportJWK(real.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  jwks = { keys: [publicJwk] };

  jwksServer = createServer((req, res) => {
    if (req.url !== "/jwks") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=300" });
    res.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks`;

  bucketServer = createServer(serveBucket);
  await new Promise<void>((resolve) => bucketServer.listen(0, "127.0.0.1", resolve));
  bucketEndpoint = `http://127.0.0.1:${(bucketServer.address() as AddressInfo).port}`;
});

afterEach(() => {
  resetBucket();
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const server of [jwksServer, bucketServer]) {
    // Both are spoken to over keep-alive connections, which `close()` waits on.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

// --- Environment -------------------------------------------------------------

type EnvOverrides = Partial<Record<keyof GatewayEnv, string | undefined>>;

/** An override of `undefined` unsets the variable, so defaults can be tested. */
function env(overrides: EnvOverrides = {}): GatewayEnv {
  const merged: Record<string, string | undefined> = {
    BUCKET_ENDPOINT,
    BUCKET_NAME: BUCKET,
    BUCKET_REGION: "us-east-1",
    BUCKET_ACCESS_KEY_ID: ACCESS_KEY_ID,
    BUCKET_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
    PUBLIC_BASE_URL: "https://pub.example.com/videoshare",
    GOOGLE_CLIENT_ID: CLIENT_ID,
    ALLOWED_EMAILS,
    ALLOWED_ORIGINS: `${SITE_ORIGIN},${OTHER_ORIGIN}`,
    PRESIGN_EXPIRY_SECONDS: "900",
    OIDC_JWKS_URL: jwksUrl,
    OIDC_ISSUER: ISSUER,
    ...overrides,
  };
  for (const [name, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[name];
  }
  return merged as GatewayEnv;
}

// --- Tokens ------------------------------------------------------------------

interface TokenOptions {
  email?: string;
  emailVerified?: boolean | undefined;
  iss?: string;
  aud?: string;
  kid?: string;
  /** Anything `setExpirationTime` accepts; `"-1m"` is an already-expired token. */
  expiresIn?: string;
  notBefore?: string;
  key?: CryptoKey;
}

function mintToken(options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    email: options.email ?? ALLOWED_EMAIL,
    sub: "112233445566778899000",
    name: "Alice Example",
  };
  if (options.emailVerified !== undefined) claims.email_verified = options.emailVerified;

  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? KID })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m");
  if (options.notBefore) jwt = jwt.setNotBefore(options.notBefore);
  return jwt.sign(options.key ?? signingKey);
}

/** The default happy-path token: a verified, whitelisted address. */
function goodToken(): Promise<string> {
  return mintToken({ emailVerified: true });
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// --- Requests ----------------------------------------------------------------

interface CallOptions {
  token?: string | null;
  origin?: string;
  method?: string;
  url?: string;
  authorization?: string;
  envOverrides?: EnvOverrides;
}

interface Answer {
  status: number;
  text: string;
  json: Record<string, unknown>;
  headers: Headers;
}

async function call(body: unknown, options: CallOptions = {}): Promise<Answer> {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (options.authorization !== undefined) headers.set("authorization", options.authorization);
  else if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.origin) headers.set("origin", options.origin);

  const method = options.method ?? "POST";
  const request = new Request(options.url ?? SIGN_URL, {
    method,
    headers,
    body: body === undefined || method === "GET" || method === "OPTIONS" ? undefined : JSON.stringify(body),
  });

  const res = await handleRequest(request, env(options.envOverrides));
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
  } catch {
    // Left as {}: tests that care assert on `text` instead.
  }
  return { status: res.status, text, json, headers: res.headers };
}

/** `POST /api/sign` with a good token unless the test says otherwise. */
async function sign(body: unknown, options: CallOptions = {}): Promise<Answer> {
  const token = options.token === null ? undefined : (options.token ?? (await goodToken()));
  return call(body, { ...options, token });
}

// --- Shared assertions -------------------------------------------------------

/**
 * Every presigned URL must point at the bucket, carry a complete SigV4 query
 * signature, and address exactly the key the gateway chose.
 */
interface PresignExpectations {
  region?: string;
  /** Defaults to the video bucket's; the analytics suites pass the stub's. */
  endpoint?: string;
  bucket?: string;
}

function expectPresigned(
  url: unknown,
  objectKey: string,
  { region = "us-east-1", endpoint = BUCKET_ENDPOINT, bucket = BUCKET }: PresignExpectations = {},
): URL {
  expect(typeof url, "presigned url is a string").toBe("string");
  const parsed = new URL(url as string);

  // The hard invariant of SPEC §15: bytes go browser↔bucket. A URL pointing at
  // the gateway would mean the gateway is in the data path.
  expect(parsed.origin, "presigned URLs must address the bucket, never the gateway").toBe(endpoint);
  // Path-style, and the key is the gateway's, not the caller's.
  expect(parsed.pathname).toBe(`/${bucket}/${objectKey}`);

  const query = parsed.searchParams;
  expect(query.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  expect(query.get("X-Amz-Credential")).toBe(
    `${ACCESS_KEY_ID}/${query.get("X-Amz-Date")?.slice(0, 8)}/${region}/s3/aws4_request`,
  );
  expect(query.get("X-Amz-Date")).toMatch(/^\d{8}T\d{6}Z$/);
  expect(query.get("X-Amz-SignedHeaders")).toContain("host");
  expect(query.get("X-Amz-Signature"), "SigV4 signatures are 64 hex characters").toMatch(
    /^[0-9a-f]{64}$/,
  );

  const expires = Number(query.get("X-Amz-Expires"));
  expect(Number.isInteger(expires), "X-Amz-Expires is an integer number of seconds").toBe(true);
  expect(expires).toBeGreaterThan(0);
  expect(expires, "SPEC §15.2 caps the presign lifetime at an hour").toBeLessThanOrEqual(3600);

  expect(parsed.href, "the secret key must never appear in a signed URL").not.toContain(
    SECRET_ACCESS_KEY,
  );
  return parsed;
}

function expectError(answer: Answer, status: number, label: string): void {
  expect(answer.status, `${label}: ${answer.text}`).toBe(status);
  expect(typeof answer.json.error, `${label}: body is { error: string }`).toBe("string");
}

// --- Config ------------------------------------------------------------------

describe("GET /api/config", () => {
  it("is public and returns exactly the four fields the client needs", async () => {
    const answer = await call(undefined, { method: "GET", url: CONFIG_URL, token: null });

    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({
      gateway: true,
      publicBaseUrl: "https://pub.example.com/videoshare",
      googleClientId: CLIENT_ID,
      analytics: false,
    });
  });

  it("reports analytics: true once ANALYTICS_BUCKET names a bucket", async () => {
    const answer = await call(undefined, {
      method: "GET",
      url: CONFIG_URL,
      token: null,
      envOverrides: { ANALYTICS_BUCKET },
    });

    expect(answer.status, answer.text).toBe(200);
    expect(answer.json.analytics).toBe(true);
  });

  it("reports analytics: false when ANALYTICS_BUCKET is unset, which is a supported setup", async () => {
    const answer = await call(undefined, {
      method: "GET",
      url: CONFIG_URL,
      token: null,
      envOverrides: { ANALYTICS_BUCKET: undefined },
    });

    expect(answer.status, answer.text).toBe(200);
    expect(answer.json.analytics).toBe(false);
    // Never absent: a site reading `undefined` and one reading `false` must not
    // be able to disagree about whether this gateway takes beacons.
    expect(Object.keys(answer.json)).toContain("analytics");
  });

  it("refuses to start when ANALYTICS_BUCKET is the video bucket", async () => {
    // SPEC §16.4: §3's bucket is world-readable by design. Watch data landing in
    // it would be published, so this is a boot-time failure, not a runtime one.
    const answer = await call(undefined, {
      method: "GET",
      url: CONFIG_URL,
      token: null,
      envOverrides: { ANALYTICS_BUCKET: BUCKET },
    });

    expect(answer.status).toBe(500);
    expect(String(answer.json.error)).toContain("ANALYTICS_BUCKET");
  });

  it("refuses an ANALYTICS_BUCKET name that is not a bucket name", async () => {
    for (const name of ["has/slash", "has?query", "x", "-leading-dash".repeat(8)]) {
      const answer = await call(undefined, {
        method: "GET",
        url: CONFIG_URL,
        token: null,
        envOverrides: { ANALYTICS_BUCKET: name },
      });
      expect(answer.status, `ANALYTICS_BUCKET=${name}`).toBe(500);
    }
  });

  it("leaks no bucket credentials and no whitelist", async () => {
    const answer = await call(undefined, { method: "GET", url: CONFIG_URL, token: null });

    for (const secret of [SECRET_ACCESS_KEY, ACCESS_KEY_ID, ALLOWED_EMAIL, "@team.example.com"]) {
      expect(answer.text, `config must not disclose ${secret}`).not.toContain(secret);
    }
  });

  it("does not answer a path it does not serve", async () => {
    const answer = await call(undefined, {
      method: "GET",
      url: "https://gateway.example.com/api/objects/anything",
      token: null,
    });
    expect(answer.status).toBe(404);
  });
});

// --- Authentication ----------------------------------------------------------

describe("POST /api/sign — token verification", () => {
  const body = { op: "create", id: randomId() };

  it("accepts a well-formed token from a whitelisted address", async () => {
    const answer = await sign(body);
    expect(answer.status, answer.text).toBe(200);
  });

  it("rejects a request with no Authorization header", async () => {
    expectError(await sign(body, { token: null }), 401, "no bearer");
  });

  it.each([
    ["a non-Bearer scheme", "Basic YWxpY2U6b3BlbiBzZXNhbWU="],
    ["an empty bearer", "Bearer "],
    ["a token that is not a JWT", "Bearer not-a-jwt"],
    ["a JWT with a mangled signature", "Bearer eyJhbGciOiJSUzI1NiJ9.eyJhIjoxfQ.AAAA"],
  ])("rejects %s", async (_label, authorization) => {
    expectError(await sign(body, { token: null, authorization }), 401, authorization);
  });

  it("rejects an unsigned alg:none token", async () => {
    const claims = {
      email: ALLOWED_EMAIL,
      email_verified: true,
      iss: ISSUER,
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
    };
    const token = `${b64urlJson({ alg: "none", typ: "JWT" })}.${b64urlJson(claims)}.`;

    expectError(await sign(body, { token }), 401, "alg:none");
  });

  it("rejects an HS256 token signed with the published JWKS modulus", async () => {
    // The classic algorithm-confusion attack: take the public key material the
    // gateway itself publishes and use it as an HMAC secret. It only works if
    // the verifier picks the algorithm out of the token's own header, which is
    // exactly what `algorithms: ["RS256"]` is there to prevent.
    const publicMaterial = new TextEncoder().encode(publicJwk.n ?? "");
    const token = await new SignJWT({ email: ALLOWED_EMAIL, email_verified: true })
      .setProtectedHeader({ alg: "HS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(publicMaterial);

    expectError(await sign(body, { token }), 401, "HS256 alg confusion");
  });

  it("rejects a valid RS256 signature from a key that is not in the JWKS", async () => {
    const token = await mintToken({ emailVerified: true, key: strangerKey });
    expectError(await sign(body, { token }), 401, "unknown signer");
  });

  it("rejects a token whose kid is not published", async () => {
    const token = await mintToken({ emailVerified: true, kid: "some-other-key" });
    expectError(await sign(body, { token }), 401, "unknown kid");
  });

  it("rejects a token from the wrong issuer", async () => {
    const token = await mintToken({ emailVerified: true, iss: "https://accounts.evil.example" });
    expectError(await sign(body, { token }), 401, "wrong iss");
  });

  it("rejects a token minted for a different OAuth client", async () => {
    const token = await mintToken({ emailVerified: true, aud: "9999-someone-else.apps.googleusercontent.com" });
    expectError(await sign(body, { token }), 401, "wrong aud");
  });

  it("rejects an expired token", async () => {
    const token = await mintToken({ emailVerified: true, expiresIn: "-1m" });
    expectError(await sign(body, { token }), 401, "expired");
  });

  it("rejects a token that is not valid yet", async () => {
    const token = await mintToken({ emailVerified: true, notBefore: "10m" });
    expectError(await sign(body, { token }), 401, "nbf in the future");
  });

  const unverified: Array<[string, boolean | undefined]> = [
    ["email_verified is false", false],
    ["email_verified is missing", undefined],
  ];

  it.each(unverified)("rejects a token where %s", async (_label, emailVerified) => {
    const token = await mintToken({ emailVerified });
    expectError(await sign(body, { token }), 401, "unverified email");
  });

  it("never echoes the bearer token back to the caller", async () => {
    const token = await mintToken({ emailVerified: true, iss: "https://accounts.evil.example" });
    const answer = await sign(body, { token });

    expect(answer.status).toBe(401);
    expect(answer.text, "an error body must not quote the credential").not.toContain(token);
  });
});

// --- Whitelist ---------------------------------------------------------------

describe("POST /api/sign — email whitelist", () => {
  const body = { op: "create", id: randomId() };

  const allowed: Array<[string, string]> = [
    ["an exact match", "alice@example.com"],
    ["an exact match in a different case", "ALICE@Example.COM"],
    ["a @domain suffix entry", "bob@team.example.com"],
    ["a @domain suffix entry in a different case", "Bob@TEAM.Example.com"],
  ];

  it.each(allowed)("allows %s", async (_label, email) => {
    const answer = await sign(body, { token: await mintToken({ email, emailVerified: true }) });
    expect(answer.status, `${email}: ${answer.text}`).toBe(200);
  });

  const denied: Array<[string, string]> = [
    ["a verified address that is simply not listed", "carol@example.com"],
    ["a domain that merely ends with the allowed one", "mallory@evilteam.example.com"],
    ["a domain that is a prefix of the allowed one", "mallory@team.example.com.evil.net"],
    ["a subdomain of the allowed domain", "mallory@sub.team.example.com"],
    ["a local part that contains an allowed address", "alice@example.com@evil.net"],
  ];

  it.each(denied)("refuses %s with 403, not 401", async (_label, email) => {
    // 403 rather than 401 matters: the client must not treat this as a stale
    // token and re-prompt for sign-in forever (SPEC §15.5).
    const answer = await sign(body, { token: await mintToken({ email, emailVerified: true }) });
    expectError(answer, 403, email);
  });

  it("refuses everyone when ALLOWED_EMAILS is empty", async () => {
    const answer = await sign(body, { envOverrides: { ALLOWED_EMAILS: "" } });
    expect(answer.status, "an empty whitelist is a closed door, not an open one").not.toBe(200);
    expect(answer.status).toBeGreaterThanOrEqual(400);
  });
});

// --- Request validation ------------------------------------------------------

describe("POST /api/sign — request validation", () => {
  const id = randomId();

  const malformed: Array<[string, unknown]> = [
    ["no body at all", undefined],
    ["an empty object", {}],
    ["an unknown op", { op: "delete", id }],
    ["op as a non-string", { op: 7, id }],
    ["a proxy-shaped op", { op: "get", id }],
    ["create with no id", { op: "create" }],
    ["a JSON array", [{ op: "create", id }]],
  ];

  it.each(malformed)("rejects %s with 400", async (_label, body) => {
    expectError(await sign(body), 400, JSON.stringify(body));
  });

  it("rejects a body that is not JSON", async () => {
    const token = await goodToken();
    const request = new Request(SIGN_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{ this is not json",
    });
    const res = await handleRequest(request, env());
    expect(res.status).toBe(400);
  });

  const badIds: Array<[string, unknown]> = [
    ["21 characters", "aaaaaaaaaaaaaaaaaaaaa"],
    ["23 characters", "aaaaaaaaaaaaaaaaaaaaaaa"],
    ["an empty string", ""],
    ["a traversal attempt", "../../../etc/passwd222"],
    ["a slash", "aaaaaaaaaaa/aaaaaaaaaa"],
    ["a percent escape", "aaaaaaaaaa%2Faaaaaaaaa"],
    ["a dot", "aaaaaaaaaaa.aaaaaaaaaa"],
    ["a query delimiter", "aaaaaaaaaaa?aaaaaaaaaa"],
    ["a NUL byte", "aaaaaaaaaaa\u0000aaaaaaaaaa"],
    ["a newline", "aaaaaaaaaaa\naaaaaaaaaa"],
    ["a non-string", 1234],
    ["null", null],
  ];

  it.each(badIds)("rejects an id with %s", async (_label, badId) => {
    expectError(await sign({ op: "create", id: badId }), 400, `id=${String(badId)}`);
  });

  it("accepts the ids the recorder actually generates", async () => {
    for (let i = 0; i < 8; i++) {
      const answer = await sign({ op: "create", id: randomId() });
      expect(answer.status, answer.text).toBe(200);
    }
  });

  const badUploadIds: Array<[string, unknown]> = [
    ["an ampersand, to smuggle a second query parameter", `${UPLOAD_ID}&partNumber=1`],
    ["a question mark", `${UPLOAD_ID}?x=1`],
    ["a percent escape", `${UPLOAD_ID}%26acl`],
    ["a hash", `${UPLOAD_ID}#frag`],
    ["a space", `${UPLOAD_ID} `],
    ["a newline", `${UPLOAD_ID}\n`],
    ["a backslash", `${UPLOAD_ID}\\`],
    ["nothing at all", ""],
    ["a non-string", 42],
  ];

  it.each(badUploadIds)("rejects an uploadId containing %s", async (_label, uploadId) => {
    expectError(await sign({ op: "abort", id, uploadId }), 400, `uploadId=${String(uploadId)}`);
  });

  it("rejects an absurdly long uploadId", async () => {
    expectError(await sign({ op: "abort", id, uploadId: "A".repeat(4096) }), 400, "long uploadId");
  });

  /**
   * The `/`, `+` and `=` of plain base64 are legal in a real upload id (S3, Ceph
   * and MinIO all mint different shapes), so the syntax gate lets them through
   * and percent-encoding — not the charset — is what makes them harmless. Prove
   * that: a delimiter-stuffed upload id must stay one opaque query *value*.
   */
  it("percent-encodes a base64 uploadId instead of letting it reach the path", async () => {
    const nasty = "2~ab+cd/ef=/../../other";
    const answer = await sign({ op: "abort", id, uploadId: nasty });

    expect(answer.status, answer.text).toBe(200);
    const url = expectPresigned(answer.json.url, `${id}/video.bin`);

    // Still this key, one uploadId parameter, and the value comes back verbatim.
    expect(url.pathname).toBe(`/${BUCKET}/${id}/video.bin`);
    expect(url.searchParams.getAll("uploadId")).toEqual([nasty]);
    expect(url.search.split("uploadId=").length - 1, "exactly one uploadId parameter").toBe(1);
    // The raw query must carry escapes, not the delimiters themselves.
    expect(url.search).toContain("%2F");
    expect(url.search).toContain("%2B");
  });

  const badPartNumbers: Array<[string, unknown[]]> = [
    ["zero", [0]],
    ["negative", [-1]],
    ["above the 10000 part limit", [10001]],
    ["fractional", [1.5]],
    ["not a number", ["1"]],
    ["NaN", [Number.NaN]],
    ["null", [null]],
    ["an empty list", []],
    ["more than 100 at a time", Array.from({ length: 101 }, (_, i) => i + 1)],
  ];

  it.each(badPartNumbers)("rejects partNumbers that are %s", async (_label, partNumbers) => {
    expectError(
      await sign({ op: "part", id, uploadId: UPLOAD_ID, partNumbers }),
      400,
      `partNumbers=${JSON.stringify(partNumbers)}`,
    );
  });

  it("rejects partNumbers that is not an array", async () => {
    expectError(await sign({ op: "part", id, uploadId: UPLOAD_ID, partNumbers: 1 }), 400, "scalar");
  });

  const missingUploadId: Array<[string, unknown]> = [
    ["part", { op: "part", id, partNumbers: [1] }],
    ["complete", { op: "complete", id }],
    ["abort", { op: "abort", id }],
  ];

  it.each(missingUploadId)("rejects %s with no uploadId", async (_label, body) => {
    expectError(await sign(body), 400, JSON.stringify(body));
  });
});

// --- Presigned URLs ----------------------------------------------------------

describe("POST /api/sign — presigned URLs", () => {
  const id = randomId();
  const videoKey = `${id}/video.bin`;

  it("presigns CreateMultipartUpload as a POST to ?uploads", async () => {
    const answer = await sign({ op: "create", id });

    expect(answer.status, answer.text).toBe(200);
    expect(answer.json.method).toBe("POST");
    const url = expectPresigned(answer.json.url, videoKey);
    expect(url.searchParams.has("uploads"), "CreateMultipartUpload is ?uploads").toBe(true);
    expect(url.searchParams.has("partNumber")).toBe(false);
  });

  it("presigns a batch of UploadPart URLs, one per requested part number", async () => {
    const partNumbers = [1, 2, 3, 4, 5, 6, 7, 8];
    const answer = await sign({ op: "part", id, uploadId: UPLOAD_ID, partNumbers });

    expect(answer.status, answer.text).toBe(200);
    const urls = answer.json.urls as Array<{ partNumber: number; url: string }>;
    expect(Array.isArray(urls)).toBe(true);
    expect(urls.map((entry) => entry.partNumber)).toEqual(partNumbers);
    if (answer.json.method !== undefined) expect(answer.json.method).toBe("PUT");

    for (const entry of urls) {
      const url = expectPresigned(entry.url, videoKey);
      expect(url.searchParams.get("partNumber")).toBe(String(entry.partNumber));
      expect(url.searchParams.get("uploadId"), "the uploadId round-trips verbatim").toBe(UPLOAD_ID);
    }
    // Distinct part numbers must not collide onto one signature.
    expect(new Set(urls.map((entry) => entry.url)).size).toBe(partNumbers.length);
  });

  it("presigns the boundary part numbers", async () => {
    const answer = await sign({ op: "part", id, uploadId: UPLOAD_ID, partNumbers: [1, 10000] });
    expect(answer.status, answer.text).toBe(200);
  });

  it("presigns CompleteMultipartUpload as a POST carrying only the uploadId", async () => {
    const answer = await sign({ op: "complete", id, uploadId: UPLOAD_ID });

    expect(answer.status, answer.text).toBe(200);
    expect(answer.json.method).toBe("POST");
    const url = expectPresigned(answer.json.url, videoKey);
    expect(url.searchParams.get("uploadId")).toBe(UPLOAD_ID);
    expect(url.searchParams.has("partNumber")).toBe(false);
    // SigV4 query auth does not sign the payload, so the client is free to send
    // the CompleteMultipartUpload XML (SPEC §15.3).
    expect(url.searchParams.get("X-Amz-Content-Sha256")).toBeNull();
  });

  it("presigns AbortMultipartUpload as a DELETE", async () => {
    const answer = await sign({ op: "abort", id, uploadId: UPLOAD_ID });

    expect(answer.status, answer.text).toBe(200);
    expect(answer.json.method).toBe("DELETE");
    const url = expectPresigned(answer.json.url, videoKey);
    expect(url.searchParams.get("uploadId")).toBe(UPLOAD_ID);
  });

  it("presigns the meta PUT against meta.json, not video.bin", async () => {
    const answer = await sign({ op: "put-meta", id });

    expect(answer.status, answer.text).toBe(200);
    expect(answer.json.method).toBe("PUT");
    expectPresigned(answer.json.url, `${id}/meta.json`);
  });

  it("builds the object key itself and ignores anything else in the body", async () => {
    const answer = await sign({
      op: "create",
      id,
      // Every one of these is a key the caller would love to control.
      key: "../../etc/passwd",
      objectKey: "someone-elses/video.bin",
      bucket: "not-your-bucket",
      Key: "/absolute",
      endpoint: "https://attacker.example.net",
      method: "GET",
    });

    expect(answer.status, answer.text).toBe(200);
    // Unchanged: still this bucket, still exactly {id}/video.bin.
    expectPresigned(answer.json.url, videoKey);
  });

  it("never returns a URL that points at the gateway itself", async () => {
    // The invariant restated as a blunt string check, so that a future "proxy
    // fallback" cannot slip in behind a passing suite.
    for (const body of [
      { op: "create", id },
      { op: "part", id, uploadId: UPLOAD_ID, partNumbers: [1] },
      { op: "complete", id, uploadId: UPLOAD_ID },
      { op: "abort", id, uploadId: UPLOAD_ID },
      { op: "put-meta", id },
      { op: "put-thumb", id },
    ]) {
      const answer = await sign(body);
      expect(answer.status, answer.text).toBe(200);
      expect(answer.text).not.toContain("gateway.example.com");
      expect(answer.text).not.toContain(SECRET_ACCESS_KEY);
      expect(answer.text).toContain(BUCKET_ENDPOINT);
    }
  });

  it("honours PRESIGN_EXPIRY_SECONDS", async () => {
    const answer = await sign(
      { op: "create", id },
      { envOverrides: { PRESIGN_EXPIRY_SECONDS: "120" } },
    );
    expect(answer.status, answer.text).toBe(200);
    expect(new URL(answer.json.url as string).searchParams.get("X-Amz-Expires")).toBe("120");
  });

  it("defaults the expiry to 900 seconds", async () => {
    const answer = await sign({ op: "create", id }, { envOverrides: { PRESIGN_EXPIRY_SECONDS: undefined } });
    expect(answer.status, answer.text).toBe(200);
    expect(new URL(answer.json.url as string).searchParams.get("X-Amz-Expires")).toBe("900");
  });

  it("never signs a URL that outlives the one-hour cap", async () => {
    const answer = await sign(
      { op: "create", id },
      { envOverrides: { PRESIGN_EXPIRY_SECONDS: "999999" } },
    );
    if (answer.status === 200) {
      expect(Number(new URL(answer.json.url as string).searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(3600);
    } else {
      // Refusing to start with a bad expiry is just as good as clamping it.
      expect(answer.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("defaults BUCKET_REGION to auto, the value R2 wants", async () => {
    const answer = await sign({ op: "create", id }, { envOverrides: { BUCKET_REGION: undefined } });
    expect(answer.status, answer.text).toBe(200);
    expectPresigned(answer.json.url, videoKey, { region: "auto" });
  });
});

// --- put-thumb (SPEC §3, §15.3) ----------------------------------------------

/**
 * The thumbnail op is `put-meta` with one field of the key changed, and this
 * suite says so case for case: the same auth, the same id validation, the same
 * `{ url, method: "PUT" }`, the same expiry — and a path that is `thumb.bin` and
 * could not be talked into being anything else. It is a sixth `op` on
 * `POST /api/sign`, not a new route and not a new body shape, so nothing here
 * exercises `core.ts` differently from the five ops above; that sameness is the
 * point.
 */
describe("POST /api/sign — put-thumb", () => {
  const id = randomId();
  const thumbKey = `${id}/thumb.bin`;

  it("presigns a PUT against thumb.bin, not video.bin and not meta.json", async () => {
    const answer = await sign({ op: "put-thumb", id });

    expect(answer.status, answer.text).toBe(200);
    expect(answer.json.method).toBe("PUT");
    const url = expectPresigned(answer.json.url, thumbKey);

    // Stated as a bare path equality too: a thumbnail signed against `meta.json`
    // would overwrite the metadata of a working video, and one signed against
    // `video.bin` would destroy the recording itself.
    expect(url.pathname).toBe(`/${BUCKET}/${thumbKey}`);
    expect(url.pathname).not.toContain("video.bin");
    expect(url.pathname).not.toContain("meta.json");
    // A single-object PUT: none of multipart's query parameters belong on it.
    expect(url.searchParams.has("uploads")).toBe(false);
    expect(url.searchParams.has("uploadId")).toBe(false);
    expect(url.searchParams.has("partNumber")).toBe(false);
  });

  it("carries the same X-Amz-Expires every other op gets", async () => {
    const answer = await sign({ op: "put-thumb", id }, { envOverrides: { PRESIGN_EXPIRY_SECONDS: "120" } });

    expect(answer.status, answer.text).toBe(200);
    expect(new URL(answer.json.url as string).searchParams.get("X-Amz-Expires")).toBe("120");
  });

  it("rejects a request with no Authorization header", async () => {
    expectError(await sign({ op: "put-thumb", id }, { token: null }), 401, "put-thumb, no bearer");
  });

  it("refuses a valid token from an address that is not whitelisted", async () => {
    // 403, not 401: a real identity that simply may not upload (SPEC §15.3).
    const token = await mintToken({ email: "carol@example.com", emailVerified: true });
    expectError(await sign({ op: "put-thumb", id }, { token }), 403, "put-thumb, not whitelisted");
  });

  const badIds: Array<[string, unknown]> = [
    ["absent", undefined],
    ["21 characters", "aaaaaaaaaaaaaaaaaaaaa"],
    ["23 characters", "aaaaaaaaaaaaaaaaaaaaaaa"],
    ["a slash", "aaaaaaaaaaa/aaaaaaaaaa"],
    ["a dot", "aaaaaaaaaaa.aaaaaaaaaa"],
    ["a traversal attempt", "../../../etc/passwd222"],
  ];

  it.each(badIds)("rejects an id that is %s with 400", async (_label, badId) => {
    const body = badId === undefined ? { op: "put-thumb" } : { op: "put-thumb", id: badId };
    expectError(await sign(body), 400, `put-thumb id=${String(badId)}`);
  });

  it("builds the object key itself and ignores anything else in the body", async () => {
    const answer = await sign({
      op: "put-thumb",
      id,
      // The key the caller would love to control — including the two keys of
      // this very video, which is what makes a thumbnail worth stealing a signature for.
      key: "../../etc/passwd",
      objectKey: `${randomId()}/video.bin`,
      Key: `${id}/meta.json`,
      bucket: "not-your-bucket",
      endpoint: "https://attacker.example.net",
      method: "GET",
    });

    expect(answer.status, answer.text).toBe(200);
    expectPresigned(answer.json.url, thumbKey);
  });
});

// --- Analytics beacons -------------------------------------------------------

const GATEWAY_ORIGIN = "https://gateway.example.com";

interface BeaconOptions {
  body?: Uint8Array;
  method?: string;
  token?: string;
  origin?: string;
  envOverrides?: EnvOverrides;
}

/**
 * Drives a beacon route against the stub bucket. `ANALYTICS_BUCKET` is on by
 * default here; a test that wants it off overrides it to `undefined`.
 */
async function beacon(path: string, options: BeaconOptions = {}): Promise<Answer> {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.origin) headers.set("origin", options.origin);

  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const init: RequestInit = { method, headers };
  if (options.body !== undefined && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    // What `navigator.sendBeacon` sends: raw bytes under a CORS-safelisted
    // content type it cannot override (SPEC §16.3). The gateway never reads it.
    headers.set("content-type", "text/plain;charset=UTF-8");
    init.body = options.body as BodyInit;
  }

  const res = await handleRequest(
    new Request(`${GATEWAY_ORIGIN}${path}`, init),
    env({ BUCKET_ENDPOINT: bucketEndpoint, ANALYTICS_BUCKET, ...options.envOverrides }),
  );
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
  } catch {
    // A 204 has no body at all; tests that care assert on `status`.
  }
  return { status: res.status, text, json, headers: res.headers };
}

/** A stand-in for `IV ‖ ciphertext ‖ tag` — opaque to everything being tested. */
function ciphertext(length = 291): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 37 + 11) % 256);
}

function puts(): BucketWrite[] {
  return bucketWrites.filter((write) => write.method === "PUT");
}

describe("POST /beacon/{videoId}/{sessionId}", () => {
  it("stores the body verbatim at {videoId}/{sessionId}.bin and answers 204", async () => {
    const videoId = randomId();
    const sessionId = randomId();
    const body = ciphertext();

    const answer = await beacon(`/beacon/${videoId}/${sessionId}`, { body, origin: SITE_ORIGIN });

    expect(answer.status, answer.text).toBe(204);
    expect(answer.text, "204 means 204 — nothing to read back").toBe("");
    expect(puts()).toHaveLength(1);

    const write = puts()[0]!;
    expect(write.path, "the key is built server-side from two validated ids").toBe(
      `/${ANALYTICS_BUCKET}/${videoId}/${sessionId}.bin`,
    );
    expect(write.body.equals(Buffer.from(body)), "ciphertext is stored byte for byte").toBe(true);
    expect(write.contentType).toBe("application/octet-stream");
    expect(write.authorization, "the gateway signs the write with its own credentials").toContain(
      "AWS4-HMAC-SHA256",
    );
  });

  it("never touches the video bucket", async () => {
    await beacon(`/beacon/${randomId()}/${randomId()}`, { body: ciphertext() });
    for (const write of bucketWrites) {
      expect(write.path.startsWith(`/${ANALYTICS_BUCKET}/`), write.path).toBe(true);
    }
  });

  it("requires no Authorization header: viewers have no identity", async () => {
    const answer = await beacon(`/beacon/${randomId()}/${randomId()}`, { body: ciphertext() });
    expect(answer.status, answer.text).toBe(204);
  });

  it("writes no log line at all on success", async () => {
    // SPEC §16.4. Not the session id, not a size, not an origin — a beacon is
    // the one request in this gateway with a *viewer* behind it.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const answer = await beacon(`/beacon/${randomId()}/${randomId()}`, {
      body: ciphertext(),
      origin: SITE_ORIGIN,
    });

    expect(answer.status).toBe(204);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  const badIds: Array<[string, string]> = [
    ["21 characters", "aaaaaaaaaaaaaaaaaaaaa"],
    ["23 characters", "aaaaaaaaaaaaaaaaaaaaaaa"],
    ["a dot", "aaaaaaaaaaa.aaaaaaaaaa"],
    ["a percent escape", "aaaaaaaaaa%2Faaaaaaaaa"],
    ["an encoded traversal", "..%2F..%2F..%2Fetc%2Fpw"],
    ["an encoded id of the right length", encodeURIComponent("aaaaaaaaaa+aaaaaaaaaaa")],
  ];

  it.each(badIds)("rejects a videoId with %s", async (_label, videoId) => {
    const answer = await beacon(`/beacon/${videoId}/${randomId()}`, { body: ciphertext() });
    expectError(answer, 400, `videoId=${videoId}`);
    expect(puts(), "nothing is written for a path that did not validate").toHaveLength(0);
  });

  it.each(badIds)("rejects a sessionId with %s", async (_label, sessionId) => {
    const answer = await beacon(`/beacon/${randomId()}/${sessionId}`, { body: ciphertext() });
    expectError(answer, 400, `sessionId=${sessionId}`);
    expect(puts()).toHaveLength(0);
  });

  it("404s a path with a third segment rather than reading it as a key", async () => {
    const answer = await beacon(`/beacon/${randomId()}/${randomId()}/video.bin`, {
      body: ciphertext(),
    });
    expect(answer.status).toBe(404);
    expect(puts()).toHaveLength(0);
  });

  it("accepts a body of exactly MAX_BEACON_BYTES", async () => {
    const answer = await beacon(`/beacon/${randomId()}/${randomId()}`, {
      body: ciphertext(16384),
    });
    expect(answer.status, answer.text).toBe(204);
    expect(puts()).toHaveLength(1);
  });

  it("rejects one byte more with 413 and stores nothing", async () => {
    const answer = await beacon(`/beacon/${randomId()}/${randomId()}`, {
      body: ciphertext(16385),
    });
    expectError(answer, 413, "oversized beacon");
    expect(puts()).toHaveLength(0);
  });

  it("rejects an empty body with 413, the same as an oversized one", async () => {
    // SPEC §16.3 gives the accepted body as a range — "1…MAX_BEACON_BYTES bytes
    // … → else 413" — so a zero-byte beacon falls outside it just as 16385 does.
    const answer = await beacon(`/beacon/${randomId()}/${randomId()}`, { body: new Uint8Array(0) });
    expectError(answer, 413, "empty beacon");
    expect(puts()).toHaveLength(0);
  });

  it("404s when the gateway has no ANALYTICS_BUCKET", async () => {
    const answer = await beacon(`/beacon/${randomId()}/${randomId()}`, {
      body: ciphertext(),
      envOverrides: { ANALYTICS_BUCKET: undefined },
    });
    expectError(answer, 404, "analytics disabled");
    expect(bucketWrites, "a disabled gateway does not talk to storage at all").toHaveLength(0);
  });

  it.each(["GET", "PUT", "DELETE", "PATCH"])("refuses %s on the write path with 405", async (method) => {
    const answer = await beacon(`/beacon/${randomId()}/${randomId()}`, { method });
    expectError(answer, 405, method);
    expect(answer.headers.get("allow")).toContain("POST");
  });

  it("refuses an origin that is not in ALLOWED_ORIGINS", async () => {
    const answer = await beacon(`/beacon/${randomId()}/${randomId()}`, {
      body: ciphertext(),
      origin: EVIL_ORIGIN,
    });
    expectError(answer, 403, "unlisted origin");
    expect(puts()).toHaveLength(0);
  });

  it("echoes an allowed origin on the 204", async () => {
    // The client never reads this answer, but the beacon must not be the one
    // route whose CORS behaviour differs from every other.
    const answer = await beacon(`/beacon/${randomId()}/${randomId()}`, {
      body: ciphertext(),
      origin: SITE_ORIGIN,
    });
    expect(answer.status).toBe(204);
    expect(answer.headers.get("access-control-allow-origin")).toBe(SITE_ORIGIN);
    expect(answer.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers a preflight for both halves of the route", async () => {
    const res = await handleRequest(
      new Request(`${GATEWAY_ORIGIN}/beacon/${randomId()}/${randomId()}`, {
        method: "OPTIONS",
        headers: { origin: SITE_ORIGIN, "access-control-request-method": "POST" },
      }),
      env({ BUCKET_ENDPOINT: bucketEndpoint, ANALYTICS_BUCKET }),
    );

    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE_ORIGIN);
    const methods = res.headers.get("access-control-allow-methods") ?? "";
    expect(methods).toContain("POST");
    expect(methods).toContain("GET");
  });

  it("answers 502 when the bucket refuses the write, logging the id and status only", async () => {
    bucketFailure = 500;
    const videoId = randomId();
    const sessionId = randomId();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const answer = await beacon(`/beacon/${videoId}/${sessionId}`, { body: ciphertext() });

    expectError(answer, 502, "bucket refused");
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0] ?? "");
    expect(line).toContain(videoId);
    expect(line).toContain("500");
    expect(line, "a failed write logs the video id and the status, and nothing else").not.toContain(
      sessionId,
    );
  });

  it("mounts at /api/beacon as well", async () => {
    const answer = await beacon(`/api/beacon/${randomId()}/${randomId()}`, { body: ciphertext() });
    expect(answer.status, answer.text).toBe(204);
    expect(puts()).toHaveLength(1);
  });

  // "/sessions" is the name clients actually use (SPEC §16.3): "beacon" is an
  // ad-block filter pattern, fatal on a cross-site gateway. "/beacon" above
  // stays accepted for already-deployed pages.
  it("mounts at /sessions and /api/sessions", async () => {
    for (const prefix of ["/sessions", "/api/sessions"]) {
      const answer = await beacon(`${prefix}/${randomId()}/${randomId()}`, { body: ciphertext() });
      expect(answer.status, `${prefix}: ${answer.text}`).toBe(204);
    }
    expect(puts()).toHaveLength(2);
  });

  // enc=b64 is the form the client always sends (SPEC §16.3): ciphertext as
  // base64url text, because transports that string-decode a text/plain body
  // (AWS API Gateway, Lambda URLs) corrupt raw bytes.
  it("decodes an enc=b64 body and stores the raw ciphertext", async () => {
    const block = ciphertext();
    const text = Buffer.from(block).toString("base64url");
    const answer = await beacon(`/sessions/${randomId()}/${randomId()}?enc=b64`, { body: new TextEncoder().encode(text) });
    expect(answer.status, answer.text).toBe(204);
    const stored = puts();
    expect(stored).toHaveLength(1);
    expect(new Uint8Array(stored[0].body)).toEqual(block);
  });

  it("rejects an enc=b64 body that is not base64url with 400", async () => {
    for (const bad of ["not valid ~ base64!", "with=padding", "has\nnewline"]) {
      const answer = await beacon(`/sessions/${randomId()}/${randomId()}?enc=b64`, { body: new TextEncoder().encode(bad) });
      expect(answer.status, `${JSON.stringify(bad)}: ${answer.text}`).toBe(400);
    }
    expect(puts()).toHaveLength(0);
  });

  it("bounds enc=b64 by the DECODED size: 16384 encoded passes, 16385 does not", async () => {
    const fits = Buffer.alloc(16384, 7).toString("base64url");
    const over = Buffer.alloc(16385, 7).toString("base64url");
    expect((await beacon(`/sessions/${randomId()}/${randomId()}?enc=b64`, { body: new TextEncoder().encode(fits) })).status).toBe(204);
    expect((await beacon(`/sessions/${randomId()}/${randomId()}?enc=b64`, { body: new TextEncoder().encode(over) })).status).toBe(413);
  });
});

// --- Session listing ---------------------------------------------------------

describe("GET /beacon/{videoId}", () => {
  function store(videoId: string, count: number): string[] {
    const sessionIds = Array.from({ length: count }, () => randomId());
    bucketObjects = sessionIds.map((sessionId, index) => ({
      key: `${videoId}/${sessionId}.bin`,
      size: 200 + index,
      lastModified: "2026-08-27T21:41:02.000Z",
    }));
    return sessionIds;
  }

  interface Listing {
    sessions: { sessionId: string; lastModified: string; size: number; url: string }[];
    truncated: boolean;
  }

  it("lists each session with a presigned GET straight at the analytics bucket", async () => {
    const videoId = randomId();
    const sessionIds = store(videoId, 3);

    const answer = await beacon(`/beacon/${videoId}`, { token: await goodToken() });

    expect(answer.status, answer.text).toBe(200);
    const listing = answer.json as unknown as Listing;
    expect(listing.truncated).toBe(false);
    expect(listing.sessions.map((session) => session.sessionId)).toEqual(sessionIds);

    listing.sessions.forEach((session, index) => {
      expect(session.size).toBe(200 + index);
      expect(session.lastModified).toBe("2026-08-27T21:41:02.000Z");
      expectPresigned(session.url, `${videoId}/${session.sessionId}.bin`, {
        endpoint: bucketEndpoint,
        bucket: ANALYTICS_BUCKET,
      });
    });
  });

  it("returns URLs the browser dereferences, never bytes and never the gateway", async () => {
    // SPEC §15/§16.3: the beacon write is the *only* place bytes pass through,
    // and there is no read path. The listing hands out signatures, not objects.
    const videoId = randomId();
    store(videoId, 2);

    const answer = await beacon(`/beacon/${videoId}`, { token: await goodToken() });

    expect(answer.headers.get("content-type")).toContain("application/json");
    expect(answer.text).not.toContain(GATEWAY_ORIGIN);
    expect(answer.text).not.toContain(SECRET_ACCESS_KEY);
    expect(answer.text).toContain(bucketEndpoint);
  });

  it("honours PRESIGN_EXPIRY_SECONDS on the session URLs", async () => {
    const videoId = randomId();
    store(videoId, 1);

    const answer = await beacon(`/beacon/${videoId}`, {
      token: await goodToken(),
      envOverrides: { PRESIGN_EXPIRY_SECONDS: "120" },
    });

    const listing = answer.json as unknown as Listing;
    expect(new URL(listing.sessions[0]!.url).searchParams.get("X-Amz-Expires")).toBe("120");
  });

  it("skips keys that are not {videoId}/{22 base64url}.bin", async () => {
    const videoId = randomId();
    const real = randomId();
    bucketObjects = [
      { key: `${videoId}/${real}.bin`, size: 291, lastModified: "2026-08-27T21:41:02.000Z" },
      { key: `${videoId}/`, size: 0, lastModified: "2026-08-27T21:41:02.000Z" },
      { key: `${videoId}/notanid.bin`, size: 7, lastModified: "2026-08-27T21:41:02.000Z" },
      { key: `${videoId}/${real}.json`, size: 7, lastModified: "2026-08-27T21:41:02.000Z" },
      { key: `${videoId}/nested/${real}.bin`, size: 7, lastModified: "2026-08-27T21:41:02.000Z" },
    ];

    const answer = await beacon(`/beacon/${videoId}`, { token: await goodToken() });

    const listing = answer.json as unknown as Listing;
    expect(listing.sessions.map((session) => session.sessionId)).toEqual([real]);
  });

  it("follows pagination to the cap and says so instead of trimming silently", async () => {
    const videoId = randomId();
    store(videoId, 1100);
    bucketPageSize = 400;

    const answer = await beacon(`/beacon/${videoId}`, { token: await goodToken() });

    expect(answer.status, answer.text).toBe(200);
    const listing = answer.json as unknown as Listing;
    expect(listing.sessions).toHaveLength(1000);
    expect(listing.truncated, "SPEC §16.3: honest truncation, not a quiet trim").toBe(true);
    expect(bucketWrites.filter((write) => write.method === "GET").length).toBeGreaterThan(1);
  });

  it("reports truncated: false when one page holds everything", async () => {
    const videoId = randomId();
    store(videoId, 5);

    const answer = await beacon(`/beacon/${videoId}`, { token: await goodToken() });
    expect((answer.json as unknown as Listing).truncated).toBe(false);
  });

  it("rejects a request with no token, before it touches the bucket", async () => {
    const answer = await beacon(`/beacon/${randomId()}`);
    expectError(answer, 401, "no bearer");
    expect(bucketWrites).toHaveLength(0);
  });

  it("rejects a verified token that is not on the upload whitelist with 403", async () => {
    const token = await mintToken({ email: "carol@example.com", emailVerified: true });
    const answer = await beacon(`/beacon/${randomId()}`, { token });
    expectError(answer, 403, "not whitelisted");
    expect(bucketWrites).toHaveLength(0);
  });

  it("rejects an expired token with 401", async () => {
    const token = await mintToken({ emailVerified: true, expiresIn: "-1m" });
    expectError(await beacon(`/beacon/${randomId()}`, { token }), 401, "expired");
  });

  it("rejects a malformed videoId with 400", async () => {
    const token = await goodToken();
    for (const videoId of ["short", "aaaaaaaaaaa.aaaaaaaaaa", "aaaaaaaaaa%2Faaaaaaaaa"]) {
      expectError(await beacon(`/beacon/${videoId}`, { token }), 400, videoId);
    }
    expect(bucketWrites).toHaveLength(0);
  });

  it("404s when the gateway has no ANALYTICS_BUCKET, token or not", async () => {
    const answer = await beacon(`/beacon/${randomId()}`, {
      token: await goodToken(),
      envOverrides: { ANALYTICS_BUCKET: undefined },
    });
    expectError(answer, 404, "analytics disabled");
  });

  it.each(["POST", "PUT", "DELETE"])("refuses %s on the listing path with 405", async (method) => {
    const answer = await beacon(`/beacon/${randomId()}`, { method, token: await goodToken() });
    expectError(answer, 405, method);
    expect(answer.headers.get("allow")).toContain("GET");
  });

  it("answers 502 when the bucket refuses the listing", async () => {
    bucketFailure = 503;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const answer = await beacon(`/beacon/${randomId()}`, { token: await goodToken() });
    expectError(answer, 502, "bucket refused the listing");
  });

  it("mounts at /api/beacon as well", async () => {
    const videoId = randomId();
    store(videoId, 1);
    const answer = await beacon(`/api/beacon/${videoId}`, { token: await goodToken() });
    expect(answer.status, answer.text).toBe(200);
    expect((answer.json as unknown as Listing).sessions).toHaveLength(1);
  });

  it("lists at /sessions, the name clients use (SPEC §16.3)", async () => {
    const videoId = randomId();
    store(videoId, 1);
    const answer = await beacon(`/sessions/${videoId}`, { token: await goodToken() });
    expect(answer.status, answer.text).toBe(200);
    expect((answer.json as unknown as Listing).sessions).toHaveLength(1);
  });

  it("puts CORS headers on the listing so the library dashboard can read it", async () => {
    const videoId = randomId();
    store(videoId, 1);
    const answer = await beacon(`/beacon/${videoId}`, {
      token: await goodToken(),
      origin: SITE_ORIGIN,
    });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.headers.get("access-control-allow-origin")).toBe(SITE_ORIGIN);
  });
});

// --- CORS --------------------------------------------------------------------

describe("CORS", () => {
  it("answers a preflight from an allowed origin", async () => {
    const request = new Request(SIGN_URL, {
      method: "OPTIONS",
      headers: {
        origin: SITE_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    const res = await handleRequest(request, env());

    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain(
      "authorization",
    );
  });

  it("echoes each configured origin, and only the one that asked", async () => {
    for (const origin of [SITE_ORIGIN, OTHER_ORIGIN]) {
      const answer = await sign({ op: "create", id: randomId() }, { origin });
      expect(answer.status, answer.text).toBe(200);
      expect(answer.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("refuses to vouch for an origin that is not on the list", async () => {
    const answer = await sign({ op: "create", id: randomId() }, { origin: EVIL_ORIGIN });
    expect(answer.headers.get("access-control-allow-origin")).not.toBe(EVIL_ORIGIN);

    const preflight = await handleRequest(
      new Request(SIGN_URL, {
        method: "OPTIONS",
        headers: { origin: EVIL_ORIGIN, "access-control-request-method": "POST" },
      }),
      env(),
    );
    expect(preflight.headers.get("access-control-allow-origin")).not.toBe(EVIL_ORIGIN);
  });

  it("never answers with a wildcard, however ALLOWED_ORIGINS is written", async () => {
    // `*` plus `Authorization` is not a combination browsers even permit, and it
    // would hand the sign endpoint to every page on the internet. SPEC §15.2
    // forbids it outright.
    for (const allowed of ["*", `*,${SITE_ORIGIN}`]) {
      const answer = await sign(
        { op: "create", id: randomId() },
        { origin: EVIL_ORIGIN, envOverrides: { ALLOWED_ORIGINS: allowed } },
      );
      expect(answer.headers.get("access-control-allow-origin")).not.toBe("*");
      expect(answer.headers.get("access-control-allow-origin")).not.toBe(EVIL_ORIGIN);
    }
  });

  it("puts CORS headers on an error too, so the browser can read the 401", async () => {
    // Without this the recorder's silent re-sign-in (SPEC §15.5) can never fire:
    // fetch() reports an opaque network failure instead of a 401.
    const answer = await sign({ op: "create", id: randomId() }, { token: null, origin: SITE_ORIGIN });
    expect(answer.status).toBe(401);
    expect(answer.headers.get("access-control-allow-origin")).toBe(SITE_ORIGIN);
  });

  it("serves the config endpoint with CORS as well", async () => {
    const answer = await call(undefined, {
      method: "GET",
      url: CONFIG_URL,
      token: null,
      origin: SITE_ORIGIN,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("access-control-allow-origin")).toBe(SITE_ORIGIN);
  });
});
