/**
 * Plain Node http adapter (SPEC §15.1): `IncomingMessage` → `Request`,
 * `Response` → `ServerResponse`. No framework, no logic — everything real
 * happens in core/auth/presign.
 *
 * Run it directly on Node >= 22.18, which strips the types itself:
 *
 *   BUCKET_ENDPOINT=... node src/node.ts
 *
 * or `npm run build && node dist/node.js`. Tests import `startGateway(env, 0)`
 * instead and read the assigned port off the returned server.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { GatewayEnv } from "./core.ts";
import { MAX_SIGN_BODY_BYTES, handleRequest, readConfig } from "./core.ts";

export const DEFAULT_PORT = 8787;

/**
 * A transport-level backstop, not the real limit: `handleRequest` rejects
 * anything over `MAX_SIGN_BODY_BYTES` with a proper CORS-carrying 413, so this
 * only has to stop a socket from streaming gigabytes into memory first.
 */
const MAX_BODY_BYTES = Math.max(MAX_SIGN_BODY_BYTES * 4, 1024 * 1024);

/**
 * Builds (but does not start) the server. `env` is captured once and passed to
 * every request, so the core's per-env instance cache — the JWKS key set and the
 * derived SigV4 signing key — lives for the life of the server.
 */
export function createGatewayServer(env: GatewayEnv): Server {
  return createServer((nodeRequest, nodeResponse) => {
    void serve(nodeRequest, nodeResponse, env);
  });
}

/** Validates the environment, then listens. Rejects if the port is unusable. */
export function startGateway(env: GatewayEnv, port: number): Promise<Server> {
  readConfig(env); // fail loudly at boot rather than on the first upload
  const server = createGatewayServer(env);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function serve(
  nodeRequest: IncomingMessage,
  nodeResponse: ServerResponse,
  env: GatewayEnv,
): Promise<void> {
  try {
    const request = await toRequest(nodeRequest);
    if (request === null) {
      // Answer first, then hang up: destroying the socket before the response is
      // written would leave the client with a connection reset and no reason.
      sendJson(nodeResponse, 413, { error: "Request body is too large." });
      nodeRequest.destroy();
      return;
    }
    await write(nodeResponse, await handleRequest(request, env));
  } catch (err) {
    console.error("[videoshare-gateway] request failed:", err instanceof Error ? err.message : err);
    if (nodeResponse.headersSent) nodeResponse.end();
    else sendJson(nodeResponse, 500, { error: "The gateway failed to handle this request." });
  }
}

/** Returns null when the body exceeded `MAX_BODY_BYTES`. */
async function toRequest(nodeRequest: IncomingMessage): Promise<Request | null> {
  const method = nodeRequest.method ?? "GET";
  // Node gives a path, not a URL. The authority only has to be syntactically
  // valid — nothing in core routes on it.
  const host = nodeRequest.headers.host ?? `localhost:${DEFAULT_PORT}`;
  const url = new URL(nodeRequest.url ?? "/", `http://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }

  let body: Uint8Array<ArrayBuffer> | null = null;
  if (method !== "GET" && method !== "HEAD") {
    const collected = await readBody(nodeRequest);
    if (collected === null) return null;
    // `BodyInit` only accepts ArrayBuffer-backed views, which a Buffer is not
    // guaranteed to be. `MAX_BODY_BYTES` bounds the copy.
    body = Uint8Array.from(collected);
  }

  return new Request(url, { method, headers, body });
}

function readBody(nodeRequest: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    nodeRequest.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    nodeRequest.on("end", () => resolve(Buffer.concat(chunks)));
    nodeRequest.on("error", reject);
  });
}

async function write(nodeResponse: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = Buffer.from(await response.arrayBuffer());
  send(nodeResponse, response.status, headers, body);
}

function send(
  nodeResponse: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
): void {
  nodeResponse.writeHead(status, headers);
  nodeResponse.end(body);
}

/** Transport-level failures, which never reach `handleRequest`, still answer `{ error }`. */
function sendJson(nodeResponse: ServerResponse, status: number, body: { error: string }): void {
  send(
    nodeResponse,
    status,
    { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    Buffer.from(JSON.stringify(body)),
  );
}

/** `node src/node.ts` / `node dist/node.js` — but not `import`. */
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  const port = Number(process.env["PORT"] ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[videoshare-gateway] PORT is not a valid port number: ${process.env["PORT"]}`);
    process.exit(1);
  }
  try {
    await startGateway(process.env, port);
    console.log(`[videoshare-gateway] listening on http://localhost:${port} (GET /api/config, POST /api/sign)`);
  } catch (err) {
    console.error(`[videoshare-gateway] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
