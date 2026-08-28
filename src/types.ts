/** Shared data shapes. See docs/SPEC.md §5, §9, §11. */

/**
 * Constant-quality target for the WebCodecs engine (SPEC §6); the fallback
 * MediaRecorder engine ignores it and uses `Settings.videoBitsPerSecond`.
 * `encoder.ts` maps it to a per-codec quantizer.
 */
export type Quality = "smaller" | "standard" | "sharper";

/**
 * Which video codec the WebCodecs engine should aim for (SPEC §6/§9).
 *
 * `"auto"` takes hardware H.264 when the browser offers it and VP9 otherwise —
 * the choice that keeps frames from being dropped at native Retina resolution
 * without asking the user to know why. The explicit values are a promise about
 * intent, not about the result: a codec this browser cannot encode falls back
 * down the same chain, and the page says which one was actually used.
 */
export type CodecChoice = "auto" | "h264" | "vp9" | "av1";

/** Plaintext metadata for one video, encrypted into `{id}/meta.json`. */
export interface VideoMeta {
  /** Format version. */
  v: 1;
  /** User-entered title; may be "". */
  title: string;
  /** Exact container/codec string the recording engine used, e.g. "video/webm;codecs=vp09.00.10.08,opus". */
  mimeType: string;
  durationMs: number;
  /** Plaintext (pre-encryption) video byte length. */
  totalBytes: number;
  /** Plaintext chunk size used, i.e. CHUNK_SIZE. */
  chunkSize: number;
  chunkCount: number;
  /** ISO 8601 UTC. */
  createdAt: string;
}

/** Recorder-page configuration, persisted at `videoshare.settings`. */
export interface Settings {
  /** S3 API endpoint, e.g. "https://s3.amazonaws.com" or "http://localhost:9000". */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Base URL where the bucket is publicly readable. */
  publicBaseUrl: string;
  /** Constant-quality target for the WebCodecs engine. */
  quality: Quality;
  /**
   * Which codec to record with (SPEC §9). Replaced the older `preferAv1`
   * boolean, which loads as `codec: "av1"` and is dropped on the next save.
   */
  codec: CodecChoice;
  /** Fallback MediaRecorder engine only; the WebCodecs engine is quantizer-driven. */
  videoBitsPerSecond: number;
}

/**
 * The encoder half of `Settings`, persisted on its own at `videoshare.recording`
 * (SPEC §15.5). Gateway mode has no storage settings panel to keep these in —
 * the credentials they used to sit beside live on the gateway — but the choice
 * of codec is the recording operator's, not the deployment's.
 */
export interface RecordingPrefs {
  quality: Quality;
  codec: CodecChoice;
  videoBitsPerSecond: number;
}

/**
 * What `GET {gatewayUrl}/config` answers (SPEC §15.3). Public, no auth — it
 * carries nothing secret, only what the recorder needs to sign in and to check
 * that config.js points viewers at the same bucket the gateway writes to.
 */
export interface GatewayConfig {
  /** Base URL where the gateway's bucket is publicly readable. */
  publicBaseUrl: string;
  /** OAuth 2.0 client id for Google Identity Services. */
  googleClientId: string;
  /**
   * Whether the gateway has an analytics bucket, i.e. whether the beacon
   * endpoints exist at all (SPEC §16.4). A gateway built before §16 omits the
   * field, which reads as `false` — so a newer site against an older gateway
   * simply sends no beacons rather than posting them into a 404.
   */
  analytics: boolean;
}

/** One row of the local library, persisted at `videoshare.library`. */
export interface LibraryEntry {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number;
  /** Full share link, including the `#{id}.{key}` fragment. */
  link: string;
  /** Plaintext video bytes uploaded (`VideoMeta.totalBytes`). Absent on entries written before v1.1. */
  sizeBytes?: number;
}
