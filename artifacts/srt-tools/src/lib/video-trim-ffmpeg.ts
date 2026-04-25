import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";

const CORE_BASE = `${import.meta.env.BASE_URL}ffmpeg`;

const RECYCLE_EVERY = 10;
const MEMORY_ERROR_PATTERNS = [
  "memory access out of bounds",
  "out of memory",
  "abort",
  "RuntimeError",
  "not loaded",
];

let ffmpeg: FFmpeg | null = null;
let loadingPromise: Promise<FFmpeg> | null = null;
let logHandler: ((msg: string) => void) | null = null;
let trimsSinceRecycle = 0;

function isMemoryError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return MEMORY_ERROR_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

async function loadFreshInstance(): Promise<FFmpeg> {
  const instance = new FFmpeg();
  if (logHandler) {
    instance.on("log", ({ message }) => logHandler?.(message));
  }
  const coreURL = await toBlobURL(
    `${CORE_BASE}/ffmpeg-core.js`,
    "text/javascript",
  );
  const wasmURL = await toBlobURL(
    `${CORE_BASE}/ffmpeg-core.wasm`,
    "application/wasm",
  );
  await instance.load({ coreURL, wasmURL });
  return instance;
}

export async function getFFmpeg(
  onLog?: (msg: string) => void,
): Promise<FFmpeg> {
  if (onLog) logHandler = onLog;
  if (ffmpeg) return ffmpeg;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const instance = await loadFreshInstance();
    ffmpeg = instance;
    loadingPromise = null;
    return instance;
  })();

  return loadingPromise;
}

// Tear down the current ffmpeg instance and create a new one. This is
// the same "engine recycle" trick used in VideoSplitter — every N trims
// we throw away the WASM heap so memory fragmentation never accumulates.
export async function recycleFFmpeg(): Promise<FFmpeg> {
  const old = ffmpeg;
  ffmpeg = null;
  loadingPromise = null;
  if (old) {
    try {
      old.terminate();
    } catch {
      // ignore — instance may already be dead
    }
  }
  trimsSinceRecycle = 0;
  return getFFmpeg();
}

// Fully release the engine without auto-reloading. Useful when leaving
// a tab so memory is returned to the browser.
export function disposeFFmpeg(): void {
  const old = ffmpeg;
  ffmpeg = null;
  loadingPromise = null;
  trimsSinceRecycle = 0;
  if (old) {
    try {
      old.terminate();
    } catch {
      // ignore
    }
  }
}

export async function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    const url = URL.createObjectURL(file);
    video.src = url;
    video.onloadedmetadata = () => {
      const d = video.duration;
      URL.revokeObjectURL(url);
      if (!isFinite(d) || d <= 0) reject(new Error("Invalid duration"));
      else resolve(d);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read video metadata"));
    };
  });
}

export type TrimMode = "end" | "both";

export interface TrimOptions {
  cutSeconds: number;
  mode: TrimMode;
  onProgress?: (ratio: number) => void;
}

// Internal: do one trim attempt against the given ffmpeg engine.
async function trimOnce(
  ff: FFmpeg,
  file: File,
  opts: TrimOptions,
): Promise<Blob> {
  const duration = await getVideoDuration(file);

  const cut = opts.cutSeconds;
  const startCut = opts.mode === "both" ? cut : 0;
  const endCut = cut;
  const newDuration = duration - startCut - endCut;

  if (newDuration <= 0) {
    throw new Error(
      `Cut (${(startCut + endCut).toFixed(3)}s) >= video length (${duration.toFixed(3)}s)`,
    );
  }

  const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
  const safeExt = ["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(ext)
    ? ext
    : "mp4";
  const inputName = `in.${safeExt}`;
  const outputName = `out.${safeExt}`;

  await ff.writeFile(inputName, await fetchFile(file));

  const progressHandler = ({ progress }: { progress: number }) => {
    if (opts.onProgress) opts.onProgress(Math.max(0, Math.min(1, progress)));
  };
  ff.on("progress", progressHandler);

  try {
    const args = [
      "-ss",
      startCut.toFixed(3),
      "-i",
      inputName,
      "-t",
      newDuration.toFixed(3),
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      outputName,
    ];
    await ff.exec(args);
  } finally {
    ff.off("progress", progressHandler);
  }

  const data = await ff.readFile(outputName);
  await ff.deleteFile(inputName).catch(() => {});
  await ff.deleteFile(outputName).catch(() => {});

  const buf = data instanceof Uint8Array ? data : new Uint8Array();
  // Copy into a fresh ArrayBuffer to satisfy Blob's BlobPart typing
  // (some TS lib versions reject SharedArrayBuffer-backed views).
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  const mime = file.type || `video/${safeExt === "mov" ? "quicktime" : safeExt}`;
  return new Blob([ab], { type: mime });
}

export async function trimVideo(
  file: File,
  opts: TrimOptions,
): Promise<Blob> {
  // Recycle BEFORE the trim if we've hit the threshold, so the heavy
  // writeFile starts on a clean WASM heap.
  if (trimsSinceRecycle >= RECYCLE_EVERY) {
    await recycleFFmpeg();
  }

  let ff = await getFFmpeg();

  try {
    const blob = await trimOnce(ff, file, opts);
    trimsSinceRecycle += 1;
    return blob;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Memory-related failure → recycle once and retry the same file.
    if (isMemoryError(msg)) {
      ff = await recycleFFmpeg();
      const blob = await trimOnce(ff, file, opts);
      trimsSinceRecycle += 1;
      return blob;
    }

    throw err;
  }
}

export function trimmedFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}_trimmed`;
  return `${name.slice(0, dot)}_trimmed${name.slice(dot)}`;
}
