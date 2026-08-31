/**
 * The link format and the codec label (docs/SPEC.md §2, §11, §13).
 *
 * These three moved into `util.ts` in §17 — `shareLink` out of `upload.ts`,
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
 */

import { describe, expect, it } from "vitest";
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
