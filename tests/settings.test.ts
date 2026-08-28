/**
 * Recording-preferences storage (docs/SPEC.md §9, §15.5).
 *
 * `videoshare.recording` is the one key gateway mode keeps, and it is read on
 * every recording — so what matters here is that nothing in it can stop one.
 * Every value below is treated as hostile: written by an older build, hand-edited,
 * or half-overwritten by a browser that ran out of quota mid-write. Loading must
 * answer a usable `RecordingPrefs` for all of it, and saving must not throw when
 * the browser refuses storage outright (SPEC §15.5: the choice still applies to
 * the session, it just does not survive a reload).
 *
 * Node has no localStorage, so one stands in below; `storage()` in settings.ts
 * reaches it through the same global property a browser would.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CODEC,
  DEFAULT_QUALITY,
  DEFAULT_VIDEO_BITS_PER_SECOND,
  loadRecordingPrefs,
  saveRecordingPrefs,
} from "../src/settings";
import type { RecordingPrefs } from "../src/types";

const RECORDING_KEY = "videoshare.recording";

const DEFAULTS: RecordingPrefs = {
  quality: DEFAULT_QUALITY,
  codec: DEFAULT_CODEC,
  videoBitsPerSecond: DEFAULT_VIDEO_BITS_PER_SECOND,
};

// --- A localStorage that can also misbehave ----------------------------------

interface FakeStorage extends Storage {
  /** Set to throw from `setItem` instead of storing — Safari's zero private-mode quota. */
  writeError: Error | null;
}

function fakeStorage(): FakeStorage {
  const items = new Map<string, string>();
  const store: FakeStorage = {
    writeError: null,
    get length(): number {
      return items.size;
    },
    key(index: number): string | null {
      return [...items.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return items.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (store.writeError) throw store.writeError;
      items.set(key, value);
    },
    removeItem(key: string): void {
      items.delete(key);
    },
    clear(): void {
      items.clear();
    },
  };
  return store;
}

let storage: FakeStorage;

function install(value: PropertyDescriptor): void {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, ...value });
}

/** Chrome throws from the property access itself when site data is blocked. */
function blockStorage(): void {
  install({
    get(): Storage {
      throw new Error("Access to storage is not allowed from this context.");
    },
  });
}

/** Whatever is under the key, as text — including text that is not JSON at all. */
function stored(): string | null {
  return storage.getItem(RECORDING_KEY);
}

function store(value: unknown): void {
  storage.setItem(RECORDING_KEY, JSON.stringify(value));
}

beforeEach(() => {
  storage = fakeStorage();
  install({ value: storage, writable: true });
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

// --- Loading -----------------------------------------------------------------

describe("loadRecordingPrefs", () => {
  it("answers the defaults when nothing is stored", () => {
    expect(loadRecordingPrefs()).toEqual(DEFAULTS);
  });

  it("answers the defaults when the key holds something that is not an object", () => {
    for (const value of ["not json at all", JSON.stringify(null), JSON.stringify("standard"), "[]", "7"]) {
      storage.setItem(RECORDING_KEY, value);
      expect(loadRecordingPrefs(), value).toEqual(DEFAULTS);
    }
  });

  it("answers the defaults when storage is blocked", () => {
    blockStorage();
    expect(loadRecordingPrefs()).toEqual(DEFAULTS);
  });

  it("keeps every stored field it recognizes", () => {
    const prefs: RecordingPrefs = { quality: "sharper", codec: "av1", videoBitsPerSecond: 6_000_000 };
    store(prefs);
    expect(loadRecordingPrefs()).toEqual(prefs);
  });

  it("falls back per field, so one bad value cannot cost the others", () => {
    store({ quality: "sharpest", codec: "vp9", videoBitsPerSecond: 800_000 });
    expect(loadRecordingPrefs()).toEqual({
      quality: DEFAULT_QUALITY,
      codec: "vp9",
      videoBitsPerSecond: 800_000,
    });
  });

  it("rejects a codec this build does not offer", () => {
    for (const value of ["h265", "vp8", "AV1", "", 1, null]) {
      store({ codec: value });
      expect(loadRecordingPrefs().codec, JSON.stringify(value)).toBe(DEFAULT_CODEC);
    }
  });

  it("rejects a quality this build does not offer", () => {
    for (const value of ["best", "SHARPER", "", 2, null]) {
      store({ quality: value });
      expect(loadRecordingPrefs().quality, JSON.stringify(value)).toBe(DEFAULT_QUALITY);
    }
  });

  it("rejects a bitrate that is not a usable number", () => {
    for (const value of ["3000000", "", 0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
      store({ videoBitsPerSecond: value });
      expect(loadRecordingPrefs().videoBitsPerSecond, JSON.stringify(value)).toBe(
        DEFAULT_VIDEO_BITS_PER_SECOND,
      );
    }
  });

  it("rounds a fractional bitrate rather than discarding it", () => {
    store({ videoBitsPerSecond: 1_234_567.8 });
    expect(loadRecordingPrefs().videoBitsPerSecond).toBe(1_234_568);
  });

  // This key was added with the recording panel, long after the boolean it would
  // migrate from (SPEC §15.5), so a stray one is just another unknown field.
  it("does not migrate preferAv1 the way the settings key does", () => {
    store({ preferAv1: true });
    expect(loadRecordingPrefs().codec).toBe(DEFAULT_CODEC);
  });
});

// --- Saving ------------------------------------------------------------------

describe("saveRecordingPrefs", () => {
  it("round-trips every combination the panel can produce", () => {
    const prefs: RecordingPrefs = { quality: "smaller", codec: "h264", videoBitsPerSecond: 100_000 };
    expect(saveRecordingPrefs(prefs)).toBe(true);
    expect(loadRecordingPrefs()).toEqual(prefs);
  });

  it("normalizes on the way in, so nothing invalid is ever stored", () => {
    // The panel's controls cannot produce these, but a stale page open against a
    // newer build can, and the stored key outlives both.
    saveRecordingPrefs({
      quality: "sharpest",
      codec: "h265",
      videoBitsPerSecond: Number.NaN,
    } as unknown as RecordingPrefs);
    expect(JSON.parse(stored() ?? "null")).toEqual(DEFAULTS);
  });

  it("writes nothing but the three fields it owns", () => {
    saveRecordingPrefs({ ...DEFAULTS, preferAv1: true } as unknown as RecordingPrefs);
    expect(Object.keys(JSON.parse(stored() ?? "null") as object).sort()).toEqual([
      "codec",
      "quality",
      "videoBitsPerSecond",
    ]);
  });

  it("leaves the settings and library keys alone", () => {
    storage.setItem("videoshare.settings", '{"bucket":"videoshare"}');
    saveRecordingPrefs({ ...DEFAULTS, codec: "vp9" });
    expect(storage.getItem("videoshare.settings")).toBe('{"bucket":"videoshare"}');
    expect(storage.length).toBe(2);
  });

  // Both halves of "storage refused": the property access throws, and the write
  // does. Neither may throw out of here — the recording goes ahead either way.
  it("reports a blocked browser instead of throwing", () => {
    blockStorage();
    expect(saveRecordingPrefs({ ...DEFAULTS, codec: "vp9" })).toBe(false);
  });

  it("reports a refused write instead of throwing", () => {
    storage.writeError = new Error("QuotaExceededError");
    expect(saveRecordingPrefs({ ...DEFAULTS, codec: "vp9" })).toBe(false);
    expect(stored()).toBeNull();
  });
});
