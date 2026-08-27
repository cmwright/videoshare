/** Shared data shapes. See docs/SPEC.md §5, §9, §11. */

/** Plaintext metadata for one video, encrypted into `{id}/meta.json`. */
export interface VideoMeta {
  /** Format version. */
  v: 1;
  /** User-entered title; may be "". */
  title: string;
  /** Exact MediaRecorder mimeType used, e.g. "video/webm;codecs=vp9,opus". */
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
}
