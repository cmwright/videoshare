/**
 * The `#/upload` view (docs/SPEC.md §19): a file already on disk becomes a
 * share link, through the same session, library and link the recorder uses.
 *
 * pick → checking → ready → uploading → done. The pull the recorder's stages
 * have on the route (§6) applies here too: `ready`, `uploading` and `done` are
 * asking the reader for something, so a transition into them shows this view,
 * and routing away never stops an upload in flight — the nav item carries a
 * live indicator while one is.
 *
 * `record.ts` owns who authorizes an upload and what the library does with the
 * result, and hands both in as {@link ImportViewDeps}; this module owns the
 * stages, the file and the job. Nothing here decrypts, signs or stores a key:
 * the key is minted with the session and only ever leaves in the link.
 */

import { CHUNK_OVERHEAD, encryptBlock, generateKey, thumbAad } from "./crypto";
import {
  blobSource,
  captureFileThumbnail,
  createImportJob,
  type ContainerInfo,
  type ImportJob,
  planImport,
  probeMedia,
  runImport,
  sniffContainer,
} from "./import";
import type { Router } from "./shell";
import type { LibraryEntry } from "./types";
import { createUploadSession, type Signer, type UploadSession } from "./upload";
import { formatBytes, formatDuration, randomId } from "./util";

export type ImportStage = "pick" | "checking" | "ready" | "uploading" | "done";

export interface ImportViewDeps {
  router: Router;
  /**
   * Who authorizes the upload, or null once the caller has explained what is
   * missing (§17.2's `demandSettings` / `demandSignIn`). Asked at Upload, not
   * at file pick: choosing a file commits nothing.
   */
  signer(): Signer | null;
  /** The share link exists. The caller records it and re-renders the library. */
  onUploaded(entry: LibraryEntry): void;
  /** Copies `text`, flashing `button` with the outcome; resolves false when the clipboard refused. */
  copyLink(text: string, button: HTMLButtonElement): Promise<void>;
  copyToClipboard(text: string): Promise<boolean>;
  /** Runs `then` once `view` is on screen (§17.2). */
  whenRouted(view: "upload", then: () => void): void;
}

export interface ImportView {
  readonly stage: ImportStage;
  /** An upload is in flight or waiting on the reader: `beforeunload` should ask. */
  readonly busy: boolean;
  /** This view's live region, for `announce()`. */
  readonly message: HTMLElement;
}

/** Content types the picker offers; the sniffer, not this list, decides what is accepted. */
const ACCEPT = "video/*,.webm,.mkv,.mp4,.m4v,.mov";

function el<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element ${selector}`);
  return node;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What a file is called once it is a title: the name without its extension. */
export function titleFromFilename(name: string): string {
  const base = name.trim().replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
  return base.slice(0, 200);
}

/** The line under the preview: duration · size · what was found in the container. */
export function describeImport(
  info: ContainerInfo,
  durationMs: number,
  sizeBytes: number,
  width: number,
  height: number,
): string {
  const parts = [formatDuration(durationMs), formatBytes(sizeBytes)];
  if (width > 0 && height > 0) parts.push(`${width}×${height}`);
  parts.push(info.mimeType);
  return parts.join(" · ");
}

/**
 * What the reader is told about a file that will play, but not stream (§19).
 * Empty for everything else, so the line is simply absent.
 */
export function progressiveNote(info: ContainerInfo): string {
  if (info.progressive) return "";
  return (
    "This MP4 is not fragmented, so viewers download the whole file before it plays " +
    "rather than streaming it. It plays fine; it just starts later. Re-exporting with " +
    "fragmented output (ffmpeg's -movflags +frag_keyframe+empty_moov) makes it stream."
  );
}

export function initImportView(deps: ImportViewDeps): ImportView {
  const stages = Array.from(document.querySelectorAll<HTMLElement>("[data-upstage]"));
  const drop = el<HTMLLabelElement>("#up-drop");
  const fileInput = el<HTMLInputElement>("#up-file");
  const preview = el<HTMLVideoElement>("#up-preview");
  const info = el<HTMLElement>("#up-info");
  const note = el<HTMLElement>("#up-note");
  const titleInput = el<HTMLInputElement>("#up-title");
  const startButton = el<HTMLButtonElement>("#up-start");
  const cancelButton = el<HTMLButtonElement>("#up-cancel");
  const progressBar = el<HTMLElement>("#up-progress");
  const progressFill = el<HTMLElement>("#up-progress-fill");
  const progressText = el<HTMLElement>("#up-progress-text");
  const recovery = el<HTMLElement>("#up-recovery");
  const retryButton = el<HTMLButtonElement>("#up-retry");
  const abandonButton = el<HTMLButtonElement>("#up-abandon");
  const linkInput = el<HTMLInputElement>("#up-link");
  const copyButton = el<HTMLButtonElement>("#up-copy");
  const againButton = el<HTMLButtonElement>("#up-again");
  const message = el<HTMLElement>("#up-message");
  const navDot = el<HTMLElement>("#nav-upload-dot");
  const navLabel = el<HTMLElement>("#nav-upload-label");

  fileInput.accept = ACCEPT;

  let stage: ImportStage = "pick";
  /** The file the reader chose, and everything checking learned about it. */
  let chosen: { file: File; url: string; container: ContainerInfo; durationMs: number } | null = null;
  /** In flight, or waiting on a retry. */
  let active: { session: UploadSession; job: ImportJob; id: string; expectedBytes: number } | null = null;
  let running = false;
  /** Bumped whenever a choice is superseded, so a slow check cannot land on a newer one. */
  let generation = 0;

  function setStage(next: ImportStage): void {
    stage = next;
    for (const node of stages) node.classList.toggle("hidden", node.dataset.upstage !== next);
    if (next === "ready" || next === "uploading" || next === "done") deps.router.go("upload");
    const live = next === "uploading";
    navDot.classList.toggle("hidden", !live);
    navLabel.textContent = live ? "Upload in progress" : "";
  }

  function clearMessage(): void {
    message.textContent = "";
    message.classList.remove("error");
  }

  function showNote(text: string): void {
    message.textContent = text;
    message.classList.remove("error");
  }

  function showError(text: string): void {
    message.textContent = text;
    message.classList.add("error");
  }

  function setProgress(fraction: number): void {
    const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `Uploading — ${percent}%`;
    progressBar.setAttribute("aria-valuenow", String(percent));
  }

  function releaseChoice(): void {
    if (chosen) URL.revokeObjectURL(chosen.url);
    chosen = null;
    preview.removeAttribute("src");
    preview.load();
    fileInput.value = "";
  }

  async function choose(file: File): Promise<void> {
    if (stage === "uploading") return;
    const mine = ++generation;
    releaseChoice();
    clearMessage();
    setStage("checking");

    const url = URL.createObjectURL(file);
    try {
      const container = await sniffContainer(blobSource(file));
      if (!container) {
        throw new Error(
          "This is not a WebM or MP4 file this app can describe to a player. " +
            "Convert it first — ffmpeg -i input -c copy output.mp4 keeps the quality.",
        );
      }
      if (container.videoCodecs.length === 0) {
        throw new Error("This file has no video track.");
      }
      const probe = await probeMedia(url);
      if (mine !== generation) {
        URL.revokeObjectURL(url);
        return;
      }
      chosen = { file, url, container, durationMs: probe.durationMs };
      preview.src = url;
      info.textContent = describeImport(container, probe.durationMs, file.size, probe.width, probe.height);
      note.textContent = progressiveNote(container);
      titleInput.value = titleFromFilename(file.name);
      setStage("ready");
      deps.whenRouted("upload", () => titleInput.focus());
    } catch (err) {
      URL.revokeObjectURL(url);
      if (mine !== generation) return;
      setStage("pick");
      showError(describe(err));
    }
  }

  async function start(): Promise<void> {
    const current = chosen;
    if (!current || stage !== "ready" || running) return;
    clearMessage();

    const signer = deps.signer();
    if (!signer) return;

    running = true;
    startButton.disabled = true;
    try {
      const meta = planImport(current.file.size, {
        title: titleInput.value.trim(),
        mimeType: current.container.mimeType,
        durationMs: current.durationMs,
        progressive: current.container.progressive,
      });
      const id = randomId();
      const key = await generateKey();
      const expectedBytes = meta.totalBytes + meta.chunkCount * CHUNK_OVERHEAD;
      const session = await createUploadSession(signer, id, key, (uploaded) => {
        if (active?.session === session) setProgress(uploaded / expectedBytes);
      });
      // Before the first byte goes up, so a frame of the file is never in
      // memory as plaintext while the upload runs (§6's reasoning, §19).
      const jpeg = await captureFileThumbnail(current.url, current.durationMs);
      const thumb = jpeg ? await encryptBlock(key, thumbAad(id), jpeg) : null;
      active = { session, job: createImportJob(current.file, meta, thumb), id, expectedBytes };
    } catch (err) {
      running = false;
      startButton.disabled = false;
      showError(`Could not start the upload. ${describe(err)}`);
      return;
    }
    running = false;
    startButton.disabled = false;
    await attempt();
  }

  async function attempt(): Promise<void> {
    const current = active;
    const file = chosen;
    if (!current || !file || running) return;
    running = true;
    retryButton.disabled = true;
    recovery.classList.add("hidden");
    setProgress(current.session.uploadedBytes / current.expectedBytes);
    setStage("uploading");

    let link: string;
    try {
      ({ link } = await runImport(current.session, current.job));
    } catch (err) {
      running = false;
      retryButton.disabled = false;
      // Cancelled underneath this attempt: the view has already moved on.
      if (active !== current) return;
      recovery.classList.remove("hidden");
      showError(`Could not finish the upload. ${describe(err)}`);
      return;
    }

    // Recorded even if the reader cancelled while the last part was landing:
    // the video is complete in the bucket, and a link that exists must not be
    // the one thing this browser forgets.
    const meta = current.job.meta;
    deps.onUploaded({
      id: current.id,
      title: meta.title,
      createdAt: meta.createdAt,
      durationMs: meta.durationMs,
      link,
      sizeBytes: meta.totalBytes,
    });

    running = false;
    retryButton.disabled = false;
    if (active !== current) return;
    active = null;
    releaseChoice();
    linkInput.value = link;
    setStage("done");
    deps.whenRouted("upload", () => linkInput.select());
    if (await deps.copyToClipboard(link)) showNote("Link copied to your clipboard.");
    else showNote("Copy the link below — the browser blocked the automatic copy.");
  }

  function abandon(): void {
    const dropped = active;
    active = null;
    releaseChoice();
    recovery.classList.add("hidden");
    clearMessage();
    setStage("pick");
    if (dropped) void dropped.session.abort();
  }

  // --- Wiring ---------------------------------------------------------------

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void choose(file);
  });

  drop.addEventListener("dragover", (event) => {
    if (stage === "uploading") return;
    event.preventDefault();
    drop.classList.add("dragover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) void choose(file);
  });

  startButton.addEventListener("click", () => void start());
  cancelButton.addEventListener("click", () => {
    generation++;
    releaseChoice();
    clearMessage();
    setStage("pick");
  });
  retryButton.addEventListener("click", () => void attempt());
  abandonButton.addEventListener("click", abandon);
  copyButton.addEventListener("click", () => void deps.copyLink(linkInput.value, copyButton));
  againButton.addEventListener("click", () => {
    clearMessage();
    setStage("pick");
  });

  setStage("pick");

  return {
    get stage() {
      return stage;
    },
    get busy() {
      return stage === "uploading";
    },
    message,
  };
}
