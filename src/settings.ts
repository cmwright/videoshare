import type { LibraryEntry, Quality, Settings } from "./types";

const SETTINGS_KEY = "videoshare.settings";
const LIBRARY_KEY = "videoshare.library";

export const DEFAULT_REGION = "us-east-1";
export const DEFAULT_QUALITY: Quality = "standard";
export const DEFAULT_PREFER_AV1 = false;
/** Fallback MediaRecorder engine only (SPEC §6/§9). */
export const DEFAULT_VIDEO_BITS_PER_SECOND = 1_200_000;

/** Every accepted `quality` value, in UI order. */
export const QUALITIES: readonly Quality[] = ["smaller", "standard", "sharper"];

/** Every field of a stored object is untrusted until normalized. */
type Raw<T> = { [K in keyof T]?: unknown };

export function loadSettings(): Settings | null {
  const raw = readJson(SETTINGS_KEY);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const settings = normalizeSettings(raw as Raw<Settings>);
  if (!settings.endpoint || !settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) {
    return null;
  }
  return settings;
}

export function saveSettings(s: Settings): void {
  const store = storage();
  if (!store) {
    throw new Error(
      "This browser is blocking localStorage, so settings cannot be saved. " +
        "Leaving private browsing or allowing site data for this page will fix it.",
    );
  }
  try {
    store.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(s)));
  } catch (cause) {
    throw new Error(`Could not save settings to localStorage: ${describe(cause)}`, { cause });
  }
}

export function loadLibrary(): LibraryEntry[] {
  const raw = readJson(LIBRARY_KEY);
  if (!Array.isArray(raw)) return [];
  const entries: LibraryEntry[] = [];
  for (const item of raw) {
    const entry = toLibraryEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function addToLibrary(e: LibraryEntry): void {
  const entries = loadLibrary().filter((existing) => existing.id !== e.id);
  entries.unshift(e);
  writeLibrary(entries);
}

export function removeFromLibrary(id: string): void {
  const entries = loadLibrary();
  const remaining = entries.filter((entry) => entry.id !== id);
  if (remaining.length !== entries.length) writeLibrary(remaining);
}

export function publicBaseUrl(): string {
  const config = (globalThis as typeof globalThis & { VIDEOSHARE?: { publicBaseUrl?: unknown } }).VIDEOSHARE;
  const value = config && typeof config === "object" ? config.publicBaseUrl : undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "config.js did not set window.VIDEOSHARE.publicBaseUrl. Copy public/config.js next to " +
        "index.html and set publicBaseUrl to the URL where your bucket is publicly readable " +
        '(for example "http://localhost:9000/videoshare").',
    );
  }
  return trimTrailingSlash(value.trim());
}

/**
 * The local library is a convenience, not the record of truth (the share link
 * is), so a browser that refuses storage must not fail an otherwise good upload.
 */
function writeLibrary(entries: LibraryEntry[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(LIBRARY_KEY, JSON.stringify(entries));
  } catch {
    return;
  }
}

function normalizeSettings(raw: Raw<Settings>): Settings {
  return {
    endpoint: trimTrailingSlash(text(raw.endpoint).trim()),
    region: text(raw.region).trim() || DEFAULT_REGION,
    bucket: text(raw.bucket).trim().replace(/^\/+|\/+$/g, ""),
    accessKeyId: text(raw.accessKeyId).trim(),
    secretAccessKey: text(raw.secretAccessKey).trim(),
    publicBaseUrl: trimTrailingSlash(text(raw.publicBaseUrl).trim()),
    // Settings written before the two-engine rewrite carry neither key; both
    // fall back to their defaults rather than failing the load (SPEC §9).
    quality: quality(raw.quality),
    preferAv1: raw.preferAv1 === true,
    videoBitsPerSecond: wholeNumber(raw.videoBitsPerSecond, DEFAULT_VIDEO_BITS_PER_SECOND, 1),
  };
}

function toLibraryEntry(value: unknown): LibraryEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Raw<LibraryEntry>;
  const id = text(raw.id).trim();
  if (!id) return null;
  const entry: LibraryEntry = {
    id,
    title: text(raw.title),
    createdAt: text(raw.createdAt),
    durationMs: wholeNumber(raw.durationMs, 0, 0),
    link: text(raw.link),
  };
  // Optional, and stays absent for entries written before v1.1 so the UI can
  // tell "unknown size" from "zero bytes" (SPEC §9).
  if (typeof raw.sizeBytes === "number" && Number.isFinite(raw.sizeBytes) && raw.sizeBytes >= 0) {
    entry.sizeBytes = Math.round(raw.sizeBytes);
  }
  return entry;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Chrome throws on the property access itself when site data is blocked.
    return null;
  }
}

function readJson(key: string): unknown {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function quality(value: unknown): Quality {
  return QUALITIES.find((allowed) => allowed === value) ?? DEFAULT_QUALITY;
}

function wholeNumber(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.round(value) : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
