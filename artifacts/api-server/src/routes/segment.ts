import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import archiver from "archiver";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseSrt, type SrtCue } from "../lib/srt";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const BATCH_SIZE = 25;
const BATCH_CONCURRENCY = 3;
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(os.tmpdir(), "video-cutter-" + randomUUID());
      void fs.mkdir(dir, { recursive: true }).then(
        () => cb(null, dir),
        (err) => cb(err as Error, dir),
      );
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
      cb(null, safe);
    },
  }),
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024,
  },
});

interface ClipState {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  filename: string;
  status: "pending" | "running" | "done" | "error";
  error?: string;
}

interface Job {
  id: string;
  workDir: string;
  clipsDir: string;
  videoPath: string;
  ext: string;
  baseName: string;
  clips: ClipState[];
  createdAt: number;
  finishedAt?: number;
  cleanupTimer?: NodeJS.Timeout;
}

const jobs = new Map<string, Job>();

function sanitizeForFilename(text: string, max = 40): string {
  const cleaned = text
    .replace(/<[^>]*>/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\w\s\-]+/g, "")
    .trim()
    .slice(0, max)
    .replace(/\s+/g, "_");
  return cleaned || "clip";
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-300)}`));
    });
  });
}

async function fileSize(p: string): Promise<number> {
  try {
    const st = await fs.stat(p);
    return st.size;
  } catch {
    return -1;
  }
}

// One ffmpeg invocation cuts many clips from a single demux pass over the input.
async function processBatch(job: Job, batch: ClipState[]): Promise<void> {
  for (const clip of batch) clip.status = "running";

  const args: string[] = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    job.videoPath,
  ];
  for (const clip of batch) {
    const duration = clip.endSec - clip.startSec;
    args.push(
      "-ss",
      clip.startSec.toFixed(3),
      "-t",
      duration.toFixed(3),
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      path.join(job.clipsDir, clip.filename),
    );
  }

  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  // Mark each clip "done" as soon as ffmpeg moves on to the next output.
  // Detection: clip i's file exists with size>0 AND clip i+1's file has appeared.
  const poller = setInterval(() => {
    void (async () => {
      for (let i = 0; i < batch.length - 1; i++) {
        const cur = batch[i]!;
        if (cur.status !== "running") continue;
        const curSize = await fileSize(path.join(job.clipsDir, cur.filename));
        if (curSize <= 0) continue;
        const nextSize = await fileSize(
          path.join(job.clipsDir, batch[i + 1]!.filename),
        );
        if (nextSize > 0) {
          cur.status = "done";
        }
      }
    })();
  }, 400);

  try {
    await new Promise<void>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`ffmpeg exited with ${code}: ${stderr.slice(-300)}`),
          );
      });
    });
    // Anything still "running" finished on the last write.
    for (const clip of batch) {
      if (clip.status === "running") clip.status = "done";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, batchSize: batch.length }, "batch cut failed");
    for (const clip of batch) {
      if (clip.status === "running") {
        // If the output file already exists with content, treat as done.
        const sz = await fileSize(path.join(job.clipsDir, clip.filename));
        if (sz > 0) {
          clip.status = "done";
        } else {
          clip.status = "error";
          clip.error = msg;
        }
      }
    }
  } finally {
    clearInterval(poller);
  }
}

async function runJob(job: Job): Promise<void> {
  // Sort clips by startSec so each ffmpeg pass reads the file forward (cheap).
  const sorted = [...job.clips].sort((a, b) => a.startSec - b.startSec);

  const batches: ClipState[][] = [];
  for (let i = 0; i < sorted.length; i += BATCH_SIZE) {
    batches.push(sorted.slice(i, i + BATCH_SIZE));
  }

  let cursor = 0;
  const workers: Promise<void>[] = [];
  const next = async (): Promise<void> => {
    while (cursor < batches.length) {
      const i = cursor++;
      await processBatch(job, batches[i]!);
    }
  };
  for (let w = 0; w < BATCH_CONCURRENCY; w++) workers.push(next());
  await Promise.all(workers);

  job.finishedAt = Date.now();
  job.cleanupTimer = setTimeout(() => {
    void cleanupJob(job.id);
  }, JOB_TTL_MS);
}

async function cleanupJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  jobs.delete(jobId);
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  await fs.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
}

router.post(
  "/segment",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "srt", maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const files = req.files as
      | { [field: string]: Express.Multer.File[] }
      | undefined;
    const videoFile = files?.["video"]?.[0];
    const srtFile = files?.["srt"]?.[0];

    if (!videoFile || !srtFile) {
      res
        .status(400)
        .json({ error: "Both 'video' and 'srt' files are required." });
      return;
    }

    const workDir = path.dirname(videoFile.path);
    const clipsDir = path.join(workDir, "clips");

    try {
      await fs.mkdir(clipsDir, { recursive: true });
      const srtContent = await fs.readFile(srtFile.path, "utf-8");
      const cues: SrtCue[] = parseSrt(srtContent);
      await fs.unlink(srtFile.path).catch(() => {});

      if (cues.length === 0) {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        res.status(400).json({ error: "No subtitle cues found in SRT." });
        return;
      }

      const ext = path.extname(videoFile.originalname) || ".mp4";
      const baseName = path.basename(videoFile.originalname, ext);
      const padWidth = String(cues.length).length;

      const clips: ClipState[] = cues.map((c) => ({
        index: c.index,
        startSec: c.startSec,
        endSec: c.endSec,
        text: c.text,
        filename: `${String(c.index).padStart(padWidth, "0")}_${sanitizeForFilename(c.text)}${ext}`,
        status: "pending",
      }));

      const jobId = randomUUID();
      const job: Job = {
        id: jobId,
        workDir,
        clipsDir,
        videoPath: videoFile.path,
        ext,
        baseName,
        clips,
        createdAt: Date.now(),
      };
      jobs.set(jobId, job);

      // Start processing in background
      void runJob(job).catch((err) => {
        logger.error({ err, jobId }, "job failed");
      });

      res.json({
        jobId,
        baseName,
        total: clips.length,
        clips: clips.map((c) => ({
          index: c.index,
          text: c.text,
          startSec: c.startSec,
          endSec: c.endSec,
          filename: c.filename,
        })),
      });
    } catch (err) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      logger.error({ err }, "segment init failed");
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to start job",
      });
    }
  },
);

router.get("/segment/:jobId/status", (req: Request, res: Response) => {
  const job = jobs.get(req.params["jobId"]!);
  if (!job) {
    res.status(404).json({ error: "Job not found or expired." });
    return;
  }
  const done = job.clips.filter((c) => c.status === "done").length;
  const errors = job.clips.filter((c) => c.status === "error").length;
  res.json({
    total: job.clips.length,
    done,
    errors,
    finished: !!job.finishedAt,
    clips: job.clips.map((c) => ({
      index: c.index,
      status: c.status,
      error: c.error,
    })),
  });
});

router.get(
  "/segment/:jobId/clip/:index",
  (req: Request, res: Response) => {
    const job = jobs.get(req.params["jobId"]!);
    if (!job) {
      res.status(404).json({ error: "Job not found or expired." });
      return;
    }
    const idx = Number(req.params["index"]);
    const clip = job.clips.find((c) => c.index === idx);
    if (!clip) {
      res.status(404).json({ error: "Clip not found." });
      return;
    }
    if (clip.status !== "done") {
      res.status(409).json({ error: `Clip status: ${clip.status}` });
      return;
    }
    const filePath = path.join(job.clipsDir, clip.filename);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${clip.filename.replace(/"/g, "")}"`,
    );
    const stream = createReadStream(filePath);
    stream.on("error", (err) => {
      logger.error({ err }, "clip stream error");
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
  },
);

router.get("/segment/:jobId/zip", (req: Request, res: Response) => {
  const job = jobs.get(req.params["jobId"]!);
  if (!job) {
    res.status(404).json({ error: "Job not found or expired." });
    return;
  }
  const doneClips = job.clips.filter((c) => c.status === "done");
  if (doneClips.length === 0) {
    res.status(409).json({ error: "No clips ready yet." });
    return;
  }

  const zipName = `${job.baseName || "clips"}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${zipName.replace(/"/g, "")}"`,
  );

  const archive = archiver("zip", { zlib: { level: 0 } });
  archive.on("error", (err) => {
    logger.error({ err }, "zip archive error");
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  archive.pipe(res);
  for (const clip of doneClips) {
    archive.file(path.join(job.clipsDir, clip.filename), {
      name: clip.filename,
    });
  }
  void archive.finalize();
});

router.post("/segment/:jobId/cancel", async (req: Request, res: Response) => {
  await cleanupJob(req.params["jobId"]!);
  res.json({ ok: true });
});

router.post(
  "/srt-preview",
  upload.single("srt"),
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "SRT file required." });
      return;
    }
    try {
      const content = await fs.readFile(file.path, "utf-8");
      const cues = parseSrt(content);
      const sorted = [...cues].sort((a, b) => a.startSec - b.startSec);
      const overlaps: { a: number; b: number; overlapSec: number }[] = [];
      for (let i = 0; i < sorted.length - 1; i++) {
        const cur = sorted[i]!;
        const nxt = sorted[i + 1]!;
        if (nxt.startSec < cur.endSec) {
          overlaps.push({
            a: cur.index,
            b: nxt.index,
            overlapSec: +(cur.endSec - nxt.startSec).toFixed(3),
          });
        }
      }
      res.json({
        count: cues.length,
        totalSeconds: cues.reduce((s, c) => s + (c.endSec - c.startSec), 0),
        sample: cues.slice(0, 5).map((c) => ({
          index: c.index,
          startSec: c.startSec,
          endSec: c.endSec,
          text: c.text,
        })),
        overlapCount: overlaps.length,
        overlaps: overlaps.slice(0, 20),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to parse SRT",
      });
    } finally {
      fs.unlink(file.path).catch(() => {});
      fs.rm(path.dirname(file.path), { recursive: true, force: true }).catch(
        () => {},
      );
    }
  },
);

export default router;
