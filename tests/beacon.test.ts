/**
 * The viewer half of playback analytics (docs/SPEC.md §16.1, §16.2).
 *
 * `src/beacon.ts` needs a media element, a `document` and `navigator.sendBeacon`
 * to do its job, so the flush plumbing is exercised by hand in a browser. Two
 * things in it are testable in Node and are the two that matter most if they are
 * wrong:
 *
 * - `viewerId()` — the **only** localStorage key `view.html` ever writes, and
 *   the one that must never, under any browser setting, become an error a
 *   stranger who came to watch a video has to deal with (§16.1).
 * - the beacon body — the payload format, and the AAD that binds it to one
 *   video and one session. This is the shape the library dashboard parses back,
 *   so the round trip below is the two halves of §16 meeting in the middle.
 *
 * What `startWatchBeacon` adds on top — which event name calls which function —
 * stays outside the Node suites, as it is today: there is no media element here,
 * and inventing one would test the stub. That is precisely why the heat reducer
 * is pure; the arithmetic a `pause`, a seek or a resume changes lives in
 * `watch.ts` and is tested there (§16.9).
 *
 * `viewerId()` caches per page load, so each case re-imports the module through
 * `vi.resetModules()` — a fresh import is a fresh page load.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsAad, decryptBlock, encryptBlock, generateKey } from "../src/crypto";
import { randomId } from "../src/util";
import {
  HEAT_BUCKETS,
  MAX_WATCH_RANGES,
  parsePayload,
  type Range,
  type WatchPayloadV2,
} from "../src/watch";

const VIEWER_KEY = "videoshare.viewer";
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** The gateway's body cap for one beacon (SPEC §16.3); it lives in gateway/src. */
const MAX_BEACON_BYTES = 16_384;

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

/** Chrome throws on the property access itself when site data is blocked. */
function blockStorage(): void {
  install({
    get(): Storage {
      throw new Error("Access to storage is not allowed from this context.");
    },
  });
}

/** A fresh import is a fresh page load, which is what the id is scoped to. */
async function freshPageLoad(): Promise<typeof import("../src/beacon")> {
  vi.resetModules();
  return import("../src/beacon");
}

beforeEach(() => {
  storage = fakeStorage();
  install({ value: storage, writable: true });
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

// --- browserId ---------------------------------------------------------------

describe("viewerId", () => {
  it("mints a 22-character random id and keeps it", async () => {
    const { viewerId } = await freshPageLoad();
    const id = viewerId();

    expect(id).toMatch(ID_RE);
    expect(storage.getItem(VIEWER_KEY)).toBe(id);
  });

  it("stores it as a bare string, not JSON", async () => {
    // SPEC §16.1. Anything reading this key — including a future version of it —
    // reads a 22-character id, with no quotes to strip.
    const { viewerId } = await freshPageLoad();
    const id = viewerId();

    expect(storage.getItem(VIEWER_KEY)).not.toContain('"');
    expect(storage.getItem(VIEWER_KEY)).toHaveLength(22);
    expect(JSON.parse(JSON.stringify(id))).toBe(id);
  });

  it("reuses the id a previous visit stored", async () => {
    // The point of the key: three viewings by one browser collapse into one
    // viewer on the library dashboard.
    const existing = randomId();
    storage.setItem(VIEWER_KEY, existing);

    const { viewerId } = await freshPageLoad();
    expect(viewerId()).toBe(existing);
    expect(storage.getItem(VIEWER_KEY)).toBe(existing);
  });

  it("answers the same id every time within one page load", async () => {
    const { viewerId } = await freshPageLoad();
    const id = viewerId();
    expect(viewerId()).toBe(id);
    expect(viewerId()).toBe(id);
  });

  it("replaces anything under the key that is not an id", async () => {
    for (const junk of ['"quoted"', "", "short", `${randomId()}extra`, "not base64url ✱", "null"]) {
      storage.setItem(VIEWER_KEY, junk);
      const { viewerId } = await freshPageLoad();

      const id = viewerId();
      expect(id, JSON.stringify(junk)).toMatch(ID_RE);
      expect(storage.getItem(VIEWER_KEY)).toBe(id);
    }
  });

  it("does not repeat across browsers", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      storage.clear();
      const { viewerId } = await freshPageLoad();
      ids.add(viewerId());
    }
    expect(ids.size).toBe(25);
  });

  // Both halves of "storage refused", and neither may throw or be mentioned to
  // the viewer: they are a stranger who came to watch a video, not someone to
  // ask about their privacy settings (SPEC §16.1).
  it("falls back to an in-memory id when the browser blocks storage", async () => {
    blockStorage();
    const { viewerId } = await freshPageLoad();

    const id = viewerId();
    expect(id).toMatch(ID_RE);
    // Still stable for this page load — one session, one browserId.
    expect(viewerId()).toBe(id);
  });

  it("falls back to an in-memory id when the write is refused", async () => {
    storage.writeError = new Error("QuotaExceededError");
    const { viewerId } = await freshPageLoad();

    const id = viewerId();
    expect(id).toMatch(ID_RE);
    expect(viewerId()).toBe(id);
    expect(storage.getItem(VIEWER_KEY)).toBeNull();
  });

  it("writes nothing but its own key", async () => {
    // §10: view.html holds no settings and no identity. This one key is the
    // single narrowing of that, and it must not grow into a second.
    storage.setItem("videoshare.settings", '{"bucket":"videoshare"}');
    const { viewerId } = await freshPageLoad();
    viewerId();

    expect(storage.getItem("videoshare.settings")).toBe('{"bucket":"videoshare"}');
    expect(storage.length).toBe(2);
  });
});

// --- The beacon body ---------------------------------------------------------

/**
 * The payload a flush builds, as JSON — the same object `beacon.ts` assembles
 * from `viewerId()`, the session id, `playedRanges()` and `heatMs()`. Written
 * out here because what is under test is the *format* both sides depend on.
 */
function body(over: Partial<WatchPayloadV2> = {}): WatchPayloadV2 {
  return {
    v: 2,
    browserId: randomId(),
    sessionId: randomId(),
    durationMs: 93_250,
    watched: [
      [0, 41_200],
      [58_000, 93_250],
    ],
    // 50 buckets of milliseconds actually played, one per 2% (SPEC §16.2).
    heat: Array.from({ length: HEAT_BUCKETS }, (_, b) => (b < 22 ? 1865 : 0)),
    completed: false,
    firstPlayedAt: "2026-08-27T21:04:00.000Z",
    ...over,
  };
}

const utf8 = new TextEncoder();

describe("beacon payload", () => {
  it("survives the round trip the two halves of §16 make", async () => {
    // Exactly the path: JSON.stringify → encryptBlock under the analytics AAD →
    // (gateway, bucket, presigned GET) → decryptBlock → parsePayload.
    const key = await generateKey();
    const id = randomId();
    const payload = body();

    const block = await encryptBlock(
      key,
      analyticsAad(id, payload.sessionId),
      utf8.encode(JSON.stringify(payload)),
    );
    const plain = await decryptBlock(key, analyticsAad(id, payload.sessionId), block);
    const parsed = parsePayload(JSON.parse(new TextDecoder().decode(plain)) as unknown);

    expect(parsed).toEqual(payload);
    expect((parsed as WatchPayloadV2).heat).toHaveLength(HEAT_BUCKETS);
  });

  it("cannot be read under another session's id", async () => {
    // The object key is `{videoId}/{sessionId}.bin` and the AAD names the same
    // two ids, so an object moved to another key stops decrypting — which is
    // what makes an unauthenticated write endpoint safe to expose (§16.3).
    const key = await generateKey();
    const id = randomId();
    const payload = body();

    const block = await encryptBlock(
      key,
      analyticsAad(id, payload.sessionId),
      utf8.encode(JSON.stringify(payload)),
    );

    await expect(decryptBlock(key, analyticsAad(id, randomId()), block)).rejects.toThrow();
    await expect(decryptBlock(key, analyticsAad(randomId(), payload.sessionId), block)).rejects.toThrow();
  });

  it("stays inside the gateway's body cap at its most pathological", async () => {
    // Every flush carries the whole session (§16.2), so the 16 KiB cap is a cap
    // on an entire viewing — and MAX_WATCH_RANGES is what guarantees it. This is
    // the most expensive payload the format can express: 200 ranges with
    // seven-digit millisecond boundaries throughout, *and* fifty heat buckets
    // each holding a full day of replayed playback (eight digits apiece).
    //
    // §16.2 claims heat cannot grow the body the way `watched` could. That claim
    // is this assertion, not a paragraph.
    const watched: Range[] = Array.from(
      { length: MAX_WATCH_RANGES },
      (_, i): Range => [1_000_000 + i * 9999, 1_000_000 + i * 9999 + 8888],
    );
    const heat = Array.from({ length: HEAT_BUCKETS }, () => 86_400_000);
    const key = await generateKey();
    const payload = body({ durationMs: 3_600_000, watched, heat, completed: true });

    const json = utf8.encode(JSON.stringify(payload));
    const block = await encryptBlock(key, analyticsAad(randomId(), payload.sessionId), json);

    expect(block.length).toBeLessThan(MAX_BEACON_BYTES);
    // Room to spare, and heat is the small half of what is left: 50 numbers of
    // eight digits and a comma is well under a kilobyte.
    expect(MAX_BEACON_BYTES - block.length).toBeGreaterThan(4096);
    expect(JSON.stringify(heat).length).toBeLessThan(1024);
  });

  it("is opaque: nothing about the watch is visible in the bytes", async () => {
    // What the gateway and the bucket hold. The ids are inside the ciphertext,
    // which is why two sessions from one browser are not linkable server-side
    // (§16.8).
    const key = await generateKey();
    const id = randomId();
    const payload = body();

    const block = await encryptBlock(
      key,
      analyticsAad(id, payload.sessionId),
      utf8.encode(JSON.stringify(payload)),
    );
    const asText = new TextDecoder().decode(block);

    expect(asText).not.toContain(payload.browserId);
    expect(asText).not.toContain(payload.sessionId);
    expect(asText).not.toContain("watched");
    expect(asText).not.toContain("heat");
    expect(asText).not.toContain("firstPlayedAt");
  });
});
