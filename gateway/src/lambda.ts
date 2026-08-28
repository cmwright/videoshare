/**
 * AWS Lambda function-URL adapter (SPEC §15.1).
 *
 * Function URLs speak exactly one event shape — payload format **2.0** — and
 * this adapter handles both halves of it: the 2.0 *request* event below and the
 * 2.0 *response* object it returns. There is no v1.0 support because a function
 * URL never sends v1.0 (an API Gateway REST proxy would, and is not what §15.7
 * documents).
 *
 * Response **streaming is deliberately not used**: no `awslambda.streamifyResponse`,
 * no `RESPONSE_STREAM` invoke mode. The gateway's answers are a few hundred
 * bytes of JSON, and by SPEC §15 it must never carry object bytes — so leaving
 * the invoke mode at the default `BUFFERED` makes the no-proxy invariant
 * structural rather than a matter of discipline. Configure the function URL with
 * auth type NONE (the gateway authenticates with Google ID tokens itself).
 *
 * Handler path: `lambda.handler`. Environment comes from `process.env`, which is
 * the same object for the life of the execution environment, so the core's
 * JWKS and signing-key caches survive across warm invocations.
 */

import { handleRequest } from "./core.ts";

/** The subset of the function-URL 2.0 event this adapter reads. */
export interface LambdaFunctionUrlEvent {
  version?: string;
  rawPath?: string;
  rawQueryString?: string;
  /** Already lower-cased by Lambda; duplicates arrive comma-joined. */
  headers?: Record<string, string | undefined>;
  requestContext?: {
    domainName?: string;
    http?: { method?: string; path?: string };
  };
  body?: string;
  isBase64Encoded?: boolean;
}

/** The function-URL 2.0 response object (buffered, never streamed). */
export interface LambdaFunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

export async function handler(event: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResult> {
  const response = await handleRequest(toRequest(event), process.env);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  // Every response this gateway produces is JSON or empty, so text is exact.
  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
    isBase64Encoded: false,
  };
}

function toRequest(event: LambdaFunctionUrlEvent): Request {
  const method = event.requestContext?.http?.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }

  // Only the authority has to be syntactically valid — core routes on the path.
  const host = headers.get("host") ?? event.requestContext?.domainName ?? "lambda.invalid";
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = new URL(`https://${host}${path}${query}`);

  let body: Uint8Array<ArrayBuffer> | null = null;
  if (event.body !== undefined && method !== "GET" && method !== "HEAD") {
    // `BodyInit` only accepts ArrayBuffer-backed views, which a Buffer is not
    // guaranteed to be.
    body = Uint8Array.from(Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8"));
  }
  return new Request(url, { method, headers, body });
}
