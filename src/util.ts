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
