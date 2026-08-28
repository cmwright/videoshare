/** Shared data shapes. See docs/SPEC.md §5, §9, §11. */

/**
 * Constant-quality target for the WebCodecs engine (SPEC §6); the fallback
 * MediaRecorder engine ignores it and uses `Settings.videoBitsPerSecond`.
 * `encoder.ts` maps it to a per-codec quantizer.
 */
export type Quality = "smaller" | "standard" | "sharper";

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
  /** Prefer AV1 over VP9 when the browser can encode it — smaller files, fewer viewers. */
  preferAv1: boolean;
  /** Fallback MediaRecorder engine only; the WebCodecs engine is quantizer-driven. */
  videoBitsPerSecond: number;
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
