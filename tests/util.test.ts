/**
 * The link format and the codec label (docs/SPEC.md §2, §11, §13) — and, since
 * §18, deletion's two pieces of pure client logic.
 *
 * The first three moved into `util.ts` in §17 — `shareLink` out of `upload.ts`,
 * `codecLabel` out of `record.ts`'s `recordedCodec` + `CODEC_NAMES` pair — so
 * that the video page could reach them without pulling a multipart uploader or
 * two muxers in behind them. The point of the move is that they are now
 * testable in Node, so they are tested.
 *
 * ```ts
 * export function shareLink(id: string, keyB64: string): string;      // "view.html#{id}.{key}"
 * export function videoPageLink(id: string, keyB64: string): string;  // "video.html#{id}.{key}"
 * export function codecLabel(mimeType: string): string | null;
 * ```
 *
 * §18 adds the things its client half can be tested on in Node at all (§18.6):
 * the deletion **order**, which is a guarantee nothing else enforces; the
 * analytics loop's **stopping rule**, which is where a loop could fail to
 * terminate; and which grant a **403 on a DELETE** names, since the seam sends
 * that method for two intents that want two different grants. All are pure and
 * none has a suite of its own — `upload.ts` and `dashboard.ts` are otherwise a
 * network and a DOM — so §13 puts them here.
 * The menu, its confirm step, the busy row and the error sentence are not
 * tested in Node, for the reason §13 already gives for `record.ts`.
 */

import { describe, expect, it } from "vitest";
import { MAX_DELETE_ROUNDS, nextDeleteRound } from "../src/dashboard";
import { DELETE_ORDER, createGatewaySigner, createLocalSigner } from "../src/upload";
import type { Settings } from "../src/types";
import { codecLabel, parseShareFragment, randomId, shareLink, videoPageLink } from "../src/util";

/** A well-formed pair: 22 base64url characters of id, 43 of AES-256 key (§2). */
const ID = randomId();
const KEY = "b0ZxQ7yv3nJq8sTfWm2LdKpRcHgNiXeUaVzMoB4CtSw";

describe("shareLink / videoPageLink — §2's fragment", () => {
  it("puts the key in the fragment and the id beside it", () => {
    const link = shareLink(ID, KEY);
    expect(link.endsWith(`view.html#${ID}.${KEY}`)).toBe(true);
    // What a viewer's page does with it, run in reverse: the link this builds is
    // exactly the link `parseShareFragment` reads.
    expect(parseShareFragment(link.slice(link.indexOf("#")))).toEqual({ id: ID, keyB64: KEY });
  });

  it("resolves with no `location` to resolve against", () => {
    // Node has no document, and neither function may throw over it: these are
    // pure string builders that happen to resolve relatively in a browser.
    expect(() => shareLink(ID, KEY)).not.toThrow();
    expect(() => videoPageLink(ID, KEY)).not.toThrow();
    expect(shareLink(ID, KEY)).toContain("view.html#");
    expect(videoPageLink(ID, KEY)).toContain("video.html#");
  });

  it("differs from the share link only in the page it names", () => {
    // The property §17.3 leans on: a row's video-page URL is the share link
    // re-serialised, so a subpath deploy cannot make one of them right and the
    // other wrong. And the owner's page is never what Copy link hands out.
    expect(videoPageLink(ID, KEY)).toBe(shareLink(ID, KEY).replace("view.html", "video.html"));
  });

  it("keeps the two ids apart", () => {
    const other = randomId();
    expect(shareLink(other, KEY)).not.toBe(shareLink(ID, KEY));
  });
});

describe("codecLabel — what was actually written", () => {
  it("names the strings the WebCodecs engine emits", () => {
    // Full container strings, exactly as `meta.mimeType` carries them (§6).
    expect(codecLabel("video/mp4;codecs=avc1.640033,mp4a.40.2")).toBe("H.264");
    expect(codecLabel("video/webm;codecs=vp09.00.50.08,opus")).toBe("VP9");
    expect(codecLabel("video/webm;codecs=av01.0.08M.08,opus")).toBe("AV1");
  });

  it("names both H.264 registrations", () => {
    // avc3 is the in-band-parameter-set form; a muxer may write either.
    expect(codecLabel("video/mp4;codecs=avc3.640033")).toBe("H.264");
  });

  it("names MediaRecorder's shorter spelling", () => {
    // The fallback engine asks for these by name (§6), so they come back this
    // way rather than as vp09/vp08.
    expect(codecLabel("video/webm;codecs=vp9,opus")).toBe("VP9");
    expect(codecLabel("video/webm;codecs=vp8,opus")).toBe("VP8");
    expect(codecLabel("video/webm;codecs=vp08.00.41.08")).toBe("VP8");
  });

  it("is case-insensitive, because a container string is not normalized", () => {
    expect(codecLabel("VIDEO/MP4;CODECS=AVC1.640033")).toBe("H.264");
  });

  it("names nothing for a bare type", () => {
    // The last MediaRecorder candidate: the browser picked for itself and did
    // not say what. §6's fallback note prints a different sentence for this,
    // rather than claiming a codec.
    expect(codecLabel("video/webm")).toBeNull();
    expect(codecLabel("video/mp4")).toBeNull();
    expect(codecLabel("")).toBeNull();
  });
});

describe("DELETE_ORDER — §18.1's guarantee", () => {
  it("removes meta first and video last", () => {
    // The order *is* the guarantee, and nothing else enforces it: meta.json is
    // the completion marker (§8 fetches it before anything else), so from the
    // instant it is gone every copy of the share link is already the clean
    // "video not found" of §18.5. A delete that fails halfway therefore leaves
    // a video that reads as absent rather than as a torso that still looks
    // complete and then fails deeper in.
    expect([...DELETE_ORDER]).toEqual(["meta.json", "thumb.bin", "video.bin"]);
  });

  it("is §7's write order, reversed, and covers all three objects", () => {
    // §7 writes video.bin, then thumb.bin, then meta.json. Deleting in the
    // reverse order is what makes the halfway state safe in both directions.
    expect([...DELETE_ORDER].reverse()).toEqual(["video.bin", "thumb.bin", "meta.json"]);
    expect(new Set(DELETE_ORDER).size, "each of §3's objects exactly once").toBe(3);
  });
});

describe("statusHint(403, DELETE) — which grant a 403 names (§18.3)", () => {
  const settings: Settings = {
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    bucket: "videoshare",
    accessKeyId: "key",
    secretAccessKey: "secret",
    publicBaseUrl: "http://localhost:9000/videoshare",
    quality: "standard",
    codec: "auto",
    videoBitsPerSecond: 2_500_000,
  };

  const local = createLocalSigner(settings);
  const gateway = createGatewaySigner({
    gatewayUrl: "https://gateway.example.com",
    getToken: () => "token",
    refreshToken: () => Promise.resolve("token"),
  });

  it("blames s3:DeleteObject for a refused object delete, in both modes", () => {
    // §18.3's optional-IAM contract: a deployment whose credentials lack
    // s3:DeleteObject is supported, and its one failure has to read like the
    // configuration choice it is. The omitted third argument is that case, which
    // is the signature §18.3's contract is written in.
    expect(local.statusHint(403, "DELETE")).toContain("s3:DeleteObject is optional");
    expect(local.statusHint(403, "DELETE", "delete")).toContain("s3:DeleteObject is optional");
    expect(gateway.statusHint(403, "DELETE", "delete")).toContain("s3:DeleteObject");
  });

  it("does not blame it for a refused Discard, which wants the other grant", () => {
    // Discard's AbortMultipartUpload is a DELETE too, so the method alone cannot
    // tell the two apart. docs/storage-setup.md tells an operator that a 403 on
    // Discard means s3:AbortMultipartUpload is missing; naming s3:DeleteObject
    // there would send them to add a grant that changes nothing.
    const hint = local.statusHint(403, "DELETE", "abort");
    expect(hint).toContain("AbortMultipartUpload");
    expect(hint).not.toContain("s3:DeleteObject");
    expect(gateway.statusHint(403, "DELETE", "abort")).not.toContain("s3:DeleteObject");
  });
});

describe("nextDeleteRound — the analytics loop's stopping rule (§18.4)", () => {
  it("stops as soon as the gateway says the prefix is empty", () => {
    expect(nextDeleteRound({ deleted: 12, truncated: false }, 1)).toBe("done");
    // Zero deleted and not truncated is the ordinary answer for a video nobody
    // watched: there was nothing there, and that is done, not stalled.
    expect(nextDeleteRound({ deleted: 0, truncated: false }, 1)).toBe("done");
  });

  it("asks for another round while there is more and it is making progress", () => {
    expect(nextDeleteRound({ deleted: 40, truncated: true }, 1)).toBe("again");
    expect(nextDeleteRound({ deleted: 1, truncated: true }, 2)).toBe("again");
  });

  it("calls a round that deleted nothing but claims more a stall", () => {
    // A gateway that cannot make progress — a prefix holding objects its skip
    // rule refuses to touch is the way to get there. Surfacing this as a
    // failure is the whole reason the rule is a function: repeating it would
    // spin forever.
    expect(nextDeleteRound({ deleted: 0, truncated: true }, 1)).toBe("stalled");
  });

  it("runs at most MAX_DELETE_ROUNDS rounds", () => {
    // `round` is the 1-based number of the round that just answered, so
    // "again" means one more is permitted after it. The last round that may be
    // followed by another asks for one; the last permitted round itself stops.
    expect(nextDeleteRound({ deleted: 40, truncated: true }, MAX_DELETE_ROUNDS - 1)).toBe("again");
    expect(nextDeleteRound({ deleted: 40, truncated: true }, MAX_DELETE_ROUNDS)).toBe("stalled");
    expect(nextDeleteRound({ deleted: 40, truncated: true }, MAX_DELETE_ROUNDS + 1)).toBe("stalled");
  });

  it("caps a delete at exactly what §16.3 was ever willing to list", () => {
    // 25 rounds x the gateway's 40 per call = MAX_LISTED_SESSIONS (1000). A
    // prefix past that is one no reader could have seen either, so the loop
    // giving up there is not an arbitrary number.
    expect(MAX_DELETE_ROUNDS * 40).toBe(1000);
  });
});
