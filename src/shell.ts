/**
 * The owner-side shell: the sidebar's behaviour and `index.html`'s hash router
 * (docs/SPEC.md §17.1, §17.2).
 *
 * The sidebar's *markup* is not here. It is written out literally in
 * `index.html` and in `video.html`, the way the topbar is duplicated in
 * `index.html` and `view.html` today, so that both pages have a sidebar before
 * any module parses and nothing about the chrome depends on script. This module
 * owns only what has to move: which view is showing, which nav item is current,
 * and what the account chip says.
 *
 * The DOM contract both owner pages honour:
 *
 * ```html
 * <nav class="sidebar">
 *   <a class="brand" href="…#/videos">…</a>
 *   <a class="nav-item" data-route="videos"   href="…#/videos">…</a>
 *   <a class="nav-item" data-route="record"   href="…#/record">…</a>
 *   <a class="nav-item" data-route="upload"   href="…#/upload">…</a>
 *   <a class="nav-item" data-route="settings" href="…#/settings">…</a>
 *   <span class="badge-secure">Encrypted in this browser</span>
 *   <div id="account-chip" hidden>            <!-- gateway mode only -->
 *     <div id="account-identity" hidden>
 *       <span id="account-monogram"></span>
 *       <span id="account-email"></span><button id="sign-out">Sign out</button>
 *     </div>
 *     <p id="account-hint"></p>
 *     <div id="auth-button"></div>            <!-- GIS's one mount in the document -->
 *   </div>
 * </nav>
 * <section id="view-videos">…</section>       <!-- index.html only -->
 * <section id="view-record" hidden>…</section>
 * <section id="view-upload" hidden>…</section>
 * <section id="view-settings" hidden>…</section>
 * ```
 *
 * `video.html` has the nav and the chip but no sections and no router: its nav
 * links are ordinary cross-document links and **Videos** is simply marked
 * current in the markup, because a video page is a video in the library.
 */

import type { Auth, AuthState } from "./auth";

export type ViewName = "videos" | "record" | "upload" | "settings";

/** Where an empty, unknown or nonsense hash lands (SPEC §17.2). */
export const DEFAULT_VIEW: ViewName = "videos";

const VIEWS: readonly ViewName[] = ["videos", "record", "upload", "settings"];

/** What the tab says per view; the library's is the product's own name. */
const TITLES: Record<ViewName, string> = {
  videos: "VideoShare",
  record: "New recording · VideoShare",
  upload: "Upload video · VideoShare",
  settings: "Settings · VideoShare",
};

/**
 * Which view a hash names. Pure, total and never throws — every input that is
 * not exactly one of the four routes is the library, because a reader who
 * types a hash by hand or follows a stale link should land on something.
 *
 * A single trailing `/` is tolerated (`#/videos/`), and so is a missing leading
 * one, so a hand-typed `#videos` is not punished for a slash.
 */
export function parseRoute(hash: string): ViewName {
  let raw = typeof hash === "string" ? hash.trim() : "";
  if (raw.startsWith("#")) raw = raw.slice(1);
  if (raw.startsWith("/")) raw = raw.slice(1);
  if (raw.endsWith("/")) raw = raw.slice(0, -1);
  return VIEWS.find((view) => view === raw) ?? DEFAULT_VIEW;
}

/** The inverse, and the only place a route string is written. */
export function routeHash(view: ViewName): string {
  return `#/${view}`;
}

export interface Router {
  readonly view: ViewName;
  /** Pushes a history entry, so Back returns to the previous view. */
  go(view: ViewName): void;
  onChange(listener: (view: ViewName) => void): void;
}

/**
 * `index.html` only: wires `hashchange` and applies the current route once.
 *
 * Nothing is created or destroyed — all four sections are in the document from
 * the start and stay there — so the recorder's stage machine, its timer and its
 * multipart upload run on regardless of which view is showing (SPEC §17.2).
 */
export function startRouter(): Router {
  const listeners: ((view: ViewName) => void)[] = [];
  let current = parseRoute(location.hash);

  // An unrecognized or empty hash is corrected in place: a history entry for a
  // route the reader did not ask for turns Back into a trap (SPEC §17.2).
  if (location.hash !== routeHash(current)) {
    history.replaceState(history.state, "", routeHash(current));
  }

  const apply = (view: ViewName): void => {
    for (const name of VIEWS) {
      const section = document.getElementById(`view-${name}`);
      // The attribute, not a class: a hidden view leaves the accessibility tree
      // and its controls leave the tab order.
      if (section) section.hidden = name !== view;
    }
    markCurrent(view);
    document.title = TITLES[view];
  };

  const settle = (view: ViewName): void => {
    if (view === current) return;
    current = view;
    apply(view);
    for (const listener of listeners) listener(view);
  };

  window.addEventListener("hashchange", () => settle(parseRoute(location.hash)));
  apply(current);

  return {
    get view() {
      return current;
    },
    go(view) {
      // Assigning the same hash is a no-op in every browser, so a nav item
      // clicked twice does not pile up history entries.
      if (location.hash !== routeHash(view)) location.hash = routeHash(view);
      else settle(view);
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

function markCurrent(view: ViewName): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".nav-item[data-route]")) {
    if (link.dataset.route === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

// --- The account chip --------------------------------------------------------

export interface AccountChip {
  render(state: AuthState): void;
  /**
   * Draws the eye to the chip because something is waiting on sign-in. Never
   * the only signal: `demandSignIn` also moves focus and announces the reason
   * in a live region, because neither a colour nor a pulse reaches a screen
   * reader (SPEC §17.2).
   */
  highlight(): void;
}

/** A chip that is not on this page — legacy mode, or a page without one. */
const NO_CHIP: AccountChip = { render: () => {}, highlight: () => {} };

/**
 * One short line the chip can carry itself. The status text, the "loading
 * Google sign-in" sentence and the `publicBaseUrl` mismatch warning belong to
 * the Settings view's Account block: auth *messages* do not fit in a 232px
 * column (SPEC §17.1).
 */
function chipHint(state: AuthState): string {
  if (state.status === "loading") return "Loading sign-in…";
  if (state.status === "error") return "Sign-in unavailable";
  return "";
}

/**
 * Wires the sidebar's account chip (SPEC §17.1).
 *
 * `auth` of null is **legacy mode**: there is no account, nothing to sign out
 * of, and the chip is removed outright rather than left empty — the lock line
 * ends the column.
 *
 * Google's script renders its own button, so `#auth-button` must exist exactly
 * once in the document and must survive every re-render: the signed-in identity
 * and the button are two static blocks, and this only ever toggles which of them
 * is `hidden`.
 */
export function initAccountChip(auth: Auth | null): AccountChip {
  const chip = document.getElementById("account-chip");
  if (!chip) return NO_CHIP;

  if (!auth) {
    chip.remove();
    return NO_CHIP;
  }

  const identity = document.getElementById("account-identity");
  const monogram = document.getElementById("account-monogram");
  const email = document.getElementById("account-email");
  const signOut = document.getElementById("sign-out");
  const hint = document.getElementById("account-hint");
  const button = document.getElementById("auth-button");

  chip.hidden = false;
  if (button) auth.mount(button);
  signOut?.addEventListener("click", () => auth.signOut());

  const api: AccountChip = {
    render(state) {
      const signedIn = state.status === "signed-in";
      if (identity) identity.hidden = !signedIn;
      // Hidden, never removed: that is what keeps GIS's one mount point valid.
      if (button) button.hidden = signedIn;
      if (hint) hint.textContent = chipHint(state);

      const address = state.email ?? "";
      if (email) {
        email.textContent = address || "Signed in";
        // Ellipsized in a 232px column, so the whole address has to stay
        // reachable somewhere.
        if (address) email.title = address;
        else email.removeAttribute("title");
      }
      if (monogram) monogram.textContent = (address.trim()[0] ?? "?").toUpperCase();
    },
    highlight() {
      demand(chip);
      chip
        .querySelector<HTMLElement>('button, [href], input, iframe, [tabindex]:not([tabindex="-1"])')
        ?.focus();
    },
  };

  api.render(auth.state);
  return api;
}

/**
 * The one attention treatment §17.2 gives every `demand*` call: a brief ring
 * that settles into a static outline, cleared the moment the reader touches the
 * thing it points at. `prefers-reduced-motion` skips straight to the static
 * state — that is CSS's job, not this function's.
 */
export function demand(target: HTMLElement): void {
  target.classList.remove("demanded");
  // Reading a layout property restarts the animation on a re-demand.
  void target.offsetWidth;
  target.classList.add("demanded");

  const clear = (): void => {
    target.classList.remove("demanded");
    target.removeEventListener("pointerdown", clear);
    target.removeEventListener("focusin", clear);
    target.removeEventListener("keydown", clear);
  };
  target.addEventListener("pointerdown", clear);
  target.addEventListener("focusin", clear);
  target.addEventListener("keydown", clear);
}
