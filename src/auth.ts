/**
 * Google sign-in for gateway mode (docs/SPEC.md §15.5).
 *
 * The ID token this obtains is the only thing the gateway trusts, and it lives
 * in one module-private variable for the lifetime of the tab: never
 * localStorage, never sessionStorage, never a cookie, never a URL. Reload the
 * page and the token is gone — which is the point, since anyone holding it can
 * upload as this user until it expires.
 *
 * Nothing here verifies anything. The gateway checks the token's signature,
 * issuer, audience, expiry, `email_verified` and the whitelist (§15.4); the
 * claims read below are for the UI and for knowing when to ask for a fresh
 * token, and are treated as untrusted display text.
 *
 * This module only loads Google's script when gateway mode is on, so a legacy
 * deployment makes no third-party request at all.
 */

import { b64urlDecode } from "./util";

const GIS_SCRIPT = "https://accounts.google.com/gsi/client";
const GATEWAY_DOCS = "docs/gateway-setup.md";

/** A token this close to expiry is treated as gone, so a part never fails on a stale one. */
const EXPIRY_MARGIN_MS = 60_000;
/** How long a silent refresh waits before giving up and letting the UI ask. */
const REFRESH_TIMEOUT_MS = 8000;
/**
 * A part's retry ladder would otherwise fire four prompts in seven seconds.
 * After a refresh comes back empty, the next few are answered from here.
 */
const REFRESH_COOLDOWN_MS = 10_000;

export type AuthStatus = "loading" | "signed-out" | "signed-in" | "error";

export interface AuthState {
  status: AuthStatus;
  /** Email claimed by the ID token — for display only; the gateway decides who may upload. */
  email: string | null;
  /** Why sign-in is unavailable, or why the last silent refresh failed. */
  message: string | null;
}

export interface Auth {
  readonly state: AuthState;
  /** Renders Google's sign-in button into `parent` once the script is ready. */
  mount(parent: HTMLElement): void;
  /** The in-memory ID token, or null when signed out or too close to expiry. */
  getToken(): string | null;
  /**
   * Re-acquires a token without user interaction (One Tap with auto-select).
   * Resolves with a fresh token, or null when the user has to click the button.
   */
  refresh(): Promise<string | null>;
  signOut(): void;
  /** Called on every state change; `state` is a fresh snapshot. */
  onChange(listener: (state: AuthState) => void): void;
}

/** Starts loading Google Identity Services and returns immediately in `loading`. */
export function createAuth(clientId: string): Auth {
  return new GoogleAuth(clientId);
}

// --- Google Identity Services surface ----------------------------------------
// Only the pieces used here, from the "Sign in with Google" JS API reference.

interface CredentialResponse {
  /** The ID token: a JWT signed by Google. */
  credential?: string;
  select_by?: string;
}

interface PromptMomentNotification {
  getMomentType(): string;
  isSkippedMoment(): boolean;
  isDismissedMoment(): boolean;
}

interface GoogleIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: CredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    context?: string;
    ux_mode?: string;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: string;
      theme?: string;
      size?: string;
      text?: string;
      shape?: string;
      logo_alignment?: string;
      width?: string;
    },
  ): void;
  prompt(listener?: (notification: PromptMomentNotification) => void): void;
  disableAutoSelect(): void;
  cancel(): void;
}

type GoogleGlobal = { accounts?: { id?: GoogleIdApi } };

class GoogleAuth implements Auth {
  private status: AuthStatus = "loading";
  /** The ID token. In memory only — see the module comment. */
  private token: string | null = null;
  private email: string | null = null;
  private expiresAt = 0;
  private message: string | null = null;

  private readonly listeners: ((state: AuthState) => void)[] = [];
  private parent: HTMLElement | null = null;
  private api: GoogleIdApi | null = null;

  /** The in-flight silent refresh, so concurrent parts share one prompt. */
  private pending: Promise<string | null> | null = null;
  private settle: ((token: string | null) => void) | null = null;
  /** When the last empty refresh finished, for REFRESH_COOLDOWN_MS. */
  private refusedAt = 0;

  constructor(private readonly clientId: string) {
    void this.start();
  }

  get state(): AuthState {
    return { status: this.status, email: this.email, message: this.message };
  }

  mount(parent: HTMLElement): void {
    this.parent = parent;
    if (this.api) this.renderButton();
  }

  getToken(): string | null {
    if (!this.token) return null;
    // Handing out a token that expires mid-flight only buys a 401 round trip;
    // the caller treats null as "refresh first".
    if (this.expiresAt && this.expiresAt - EXPIRY_MARGIN_MS <= Date.now()) return null;
    return this.token;
  }

  refresh(): Promise<string | null> {
    if (this.pending) return this.pending;
    const api = this.api;
    if (!api) {
      // The script never loaded; nothing silent is possible.
      return Promise.resolve(null);
    }
    if (Date.now() - this.refusedAt < REFRESH_COOLDOWN_MS) return Promise.resolve(null);

    let resolve!: (token: string | null) => void;
    // Assigned before anything can call back, so a moment that arrives during
    // prompt() below cannot clear a `pending` that has not been set yet.
    const pending = new Promise<string | null>((r) => {
      resolve = r;
    });
    this.pending = pending;

    let timer = 0;
    let done = false;
    const finish = (token: string | null): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      this.settle = null;
      this.pending = null;
      if (!token) this.refusedAt = Date.now();
      resolve(token);
      if (!token) this.dropExpired();
    };
    // A One Tap moment that needs a click never calls back at all, so the upload
    // queue must not wait on it: give up and let the UI ask instead.
    timer = window.setTimeout(() => finish(null), REFRESH_TIMEOUT_MS);
    this.settle = finish;

    try {
      // auto_select (set in initialize) makes this silent for a returning user
      // with a live Google session; otherwise the moment is skipped or dismissed
      // and the button in the page is the way back in (SPEC §15.5).
      api.prompt((notification) => {
        if (notification.isSkippedMoment() || notification.isDismissedMoment()) finish(null);
      });
    } catch {
      finish(null);
    }

    return pending;
  }

  signOut(): void {
    // Settle any in-flight refresh first: its bookkeeping must not write an
    // "expired" message over a sign-out the user asked for.
    this.settle?.(null);
    this.token = null;
    this.email = null;
    this.expiresAt = 0;
    this.refusedAt = 0;
    this.message = null;
    // Without this, auto_select would sign the same account straight back in.
    this.api?.disableAutoSelect();
    this.api?.cancel();
    if (this.status !== "error") this.status = "signed-out";
    this.emit();
  }

  onChange(listener: (state: AuthState) => void): void {
    this.listeners.push(listener);
  }

  // --- internals -------------------------------------------------------------

  private async start(): Promise<void> {
    let api: GoogleIdApi;
    try {
      api = await loadGoogleIdentity();
    } catch (err) {
      this.status = "error";
      this.message =
        `Could not load Google sign-in from ${GIS_SCRIPT} — a network block, an extension, or an ` +
        `offline machine. Uploads need it in gateway mode. (${describe(err)})`;
      this.emit();
      return;
    }

    try {
      api.initialize({
        client_id: this.clientId,
        callback: (response) => this.onCredential(response),
        // Lets refresh() get a token back with no interaction.
        auto_select: true,
        context: "use",
      });
    } catch (err) {
      this.status = "error";
      this.message =
        `Google sign-in rejected the client id from the gateway's GOOGLE_CLIENT_ID. Check that it ` +
        `is an OAuth 2.0 *Web application* client and that this site's origin is an authorized ` +
        `JavaScript origin. See ${GATEWAY_DOCS}. (${describe(err)})`;
      this.emit();
      return;
    }

    this.api = api;
    this.status = "signed-out";
    this.renderButton();
    this.emit();
  }

  private renderButton(): void {
    if (!this.parent || !this.api) return;
    try {
      this.api.renderButton(this.parent, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "signin_with",
        shape: "rectangular",
      });
    } catch (err) {
      this.status = "error";
      this.message = `Google's sign-in button could not be drawn. (${describe(err)})`;
      this.emit();
    }
  }

  /** Every credential — button click, One Tap, or a silent refresh — arrives here. */
  private onCredential(response: CredentialResponse): void {
    const token = typeof response.credential === "string" ? response.credential : "";
    if (!token) {
      this.message = "Google returned no ID token. Try signing in again.";
      this.emit();
      return;
    }

    const claims = readClaims(token);
    this.token = token;
    this.email = claims.email;
    this.expiresAt = claims.expiresAt;
    this.refusedAt = 0;
    this.message = null;
    this.status = "signed-in";
    // A refresh that timed out already resolved null; the queue's next attempt
    // picks this token up regardless.
    this.settle?.(token);
    this.emit();
  }

  /**
   * A silent refresh that came back empty leaves the UI honest: the token still
   * held is past use, so this reads as signed out and the page can ask for a
   * click. Nothing about the recording changes (SPEC §15.5).
   */
  private dropExpired(): void {
    if (this.status !== "signed-in" || this.getToken()) return;
    this.token = null;
    this.email = null;
    this.expiresAt = 0;
    this.status = "signed-out";
    this.message = "Your Google sign-in expired.";
    this.emit();
  }

  private emit(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) listener(snapshot);
  }
}

// --- Script loading ----------------------------------------------------------

let loading: Promise<GoogleIdApi> | null = null;

/** Adds Google's script tag once, and only when gateway mode actually needs it. */
function loadGoogleIdentity(): Promise<GoogleIdApi> {
  if (loading) return loading;

  loading = new Promise<GoogleIdApi>((resolve, reject) => {
    const existing = googleId();
    if (existing) {
      resolve(existing);
      return;
    }

    const script = document.createElement("script");
    script.src = GIS_SCRIPT;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      const api = googleId();
      if (api) resolve(api);
      else reject(new Error("the script loaded but window.google.accounts.id was missing"));
    });
    script.addEventListener("error", () => reject(new Error("the script could not be fetched")));
    document.head.append(script);
  });

  // A failed load must not poison a later retry (e.g. after the network returns).
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

function googleId(): GoogleIdApi | null {
  const google = (globalThis as typeof globalThis & { google?: GoogleGlobal }).google;
  return google?.accounts?.id ?? null;
}

// --- Claims ------------------------------------------------------------------

/**
 * Reads `email` and `exp` out of the ID token's payload. This is NOT
 * verification — the signature is never checked here, and it must not be: the
 * gateway is the only thing that decides whether a token is real (SPEC §15.4).
 * A token whose payload will not parse is still handed over; the gateway will
 * reject it, and inventing a client-side rule would only be a second, weaker
 * one to keep in sync.
 */
function readClaims(token: string): { email: string | null; expiresAt: number } {
  const payload = token.split(".")[1];
  if (!payload) return { email: null, expiresAt: 0 };
  let claims: Record<string, unknown>;
  try {
    const json = new TextDecoder().decode(b64urlDecode(payload));
    const parsed = JSON.parse(json) as unknown;
    claims = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { email: null, expiresAt: 0 };
  }
  const email = typeof claims.email === "string" ? claims.email : null;
  const exp = typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 : 0;
  return { email, expiresAt: exp };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
