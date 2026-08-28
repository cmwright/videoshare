/**
 * Cloudflare Worker adapter (SPEC §15.1).
 *
 * Workers already speak WHATWG Request/Response and hand the bindings in as
 * `env`, so there is nothing to translate — this file exists only to name the
 * entry point for wrangler. All behaviour lives in core/auth/presign.
 *
 * Deploy with `wrangler deploy`; see wrangler.jsonc for the `wrangler secret put`
 * list.
 */

import type { GatewayEnv } from "./core.ts";
import { handleRequest } from "./core.ts";

export default {
  fetch(request: Request, env: GatewayEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
