/** Small pure helpers: ids, base64url (RFC 4648 §5, unpadded), display formatting. */

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const B64URL_REVERSE = /* @__PURE__ */ (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64URL.length; i++) table[B64URL.charCodeAt(i)] = i;
  return table;
})();

/** 16 random bytes as base64url — a 22-char video id. */
export function randomId(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

export function b64urlEncode(bytes: Uint8Array): string {
  const n = bytes.length;
  let out = "";
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const w = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(w >> 18) & 63] + B64URL[(w >> 12) & 63] + B64URL[(w >> 6) & 63] + B64URL[w & 63];
  }
  const rest = n - i;
  if (rest === 1) {
    const w = bytes[i] << 16;
    out += B64URL[(w >> 18) & 63] + B64URL[(w >> 12) & 63];
  } else if (rest === 2) {
    const w = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(w >> 18) & 63] + B64URL[(w >> 12) & 63] + B64URL[(w >> 6) & 63];
  }
  return out;
}

/** Accepts unpadded base64url; tolerates trailing "=" padding. Throws on any other stray character. */
export function b64urlDecode(s: string): Uint8Array {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 61 /* = */) end--;
  if (end % 4 === 1) throw new Error("invalid base64url: truncated final character");

  const out = new Uint8Array((end * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const code = s.charCodeAt(i);
    const v = code < 128 ? B64URL_REVERSE[code] : -1;
    if (v < 0) throw new Error(`invalid base64url: unexpected character ${JSON.stringify(s[i])}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** "m:ss" under an hour, "h:mm:ss" at or above it. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** `#{id}.{key}` — 22-char base64url id, 43-char base64url AES-256 key (SPEC §2). */
const SHARE_FRAGMENT_RE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/**
 * Reads a share link's fragment (SPEC §2), with or without the leading `#`.
 * Null for anything that is not exactly `{id}.{key}` — a truncated paste, a
 * bare id, an empty hash.
 *
 * The player and the library dashboard both come at a video this way, which is
 * why the format lives here rather than in either of them. Note that the key
 * never leaves this parse: callers turn it into a `CryptoKey` and drop the
 * string.
 */
export function parseShareFragment(fragment: string): { id: string; keyB64: string } | null {
  let raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // not percent-encoded; use it as-is
  }
  const m = SHARE_FRAGMENT_RE.exec(raw.trim());
  return m ? { id: m[1], keyB64: m[2] } : null;
}

/**
 * The share link for a video (SPEC §2) — `{site}/view.html#{id}.{key}`.
 *
 * Resolved against the current document, so a deployment under a subpath gets
 * the right URL, and a link built on `video.html` is byte-identical to the one
 * the recorder stored from `index.html`. With no `location` at all (Node tests)
 * it degrades to the relative form rather than throwing.
 */
export function shareLink(id: string, keyB64: string): string {
  return pageLink("view.html", id, keyB64);
}

/**
 * The owner's video page for the same video (SPEC §17.3) —
 * `{site}/video.html#{id}.{key}`, resolved exactly as {@link shareLink} is.
 *
 * Never handed to anyone: this is the link a library row points at, built by
 * re-serialising an entry's parsed fragment. The **share** link is what Copy
 * link copies.
 */
export function videoPageLink(id: string, keyB64: string): string {
  return pageLink("video.html", id, keyB64);
}

function pageLink(page: string, id: string, keyB64: string): string {
  const fragment = `#${id}.${keyB64}`;
  const here = typeof location === "undefined" ? "" : location.href;
  return here ? new URL(page, here).href + fragment : `${page}${fragment}`;
}

/**
 * Which codec a container's mime type says it holds (SPEC §11), for display.
 *
 * The one field guaranteed to describe what was really written, whichever
 * engine and container produced it. Both registrations appear: `avc1`/`avc3`
 * for H.264 in MP4, `vp09`/`av01`/`vp08` in WebM, and MediaRecorder's shorter
 * `vp9`/`vp8` spelling. `null` for a bare `video/webm`, which names nothing —
 * the last MediaRecorder candidate, where the browser picked for itself and did
 * not say what.
 */
export function codecLabel(mimeType: string): string | null {
  const type = mimeType.toLowerCase();
  if (/\b(?:avc1|avc3|h264)\b/.test(type)) return "H.264";
  if (/\b(?:vp09|vp9)\b/.test(type)) return "VP9";
  if (/\b(?:av01|av1)\b/.test(type)) return "AV1";
  if (/\b(?:vp08|vp8)\b/.test(type)) return "VP8";
  return null;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Decimal (SI) units, one decimal place above bytes: "12.3 MB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
