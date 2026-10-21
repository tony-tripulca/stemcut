require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const { spawn } = require("child_process");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const publicDirectory = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(os.tmpdir(), "stemcut-uploads");
const JOB_DIR = path.join(os.tmpdir(), "stemcut-jobs");

// Override DEMUCS_PATH if your Demucs CLI is installed elsewhere.
// Example: DEMUCS_PATH=/home/your-user/demucs-env/bin/demucs npm start
const DEMUCS_PATH = process.env.DEMUCS_PATH || "demucs";
const MODEL = process.env.DEMUCS_MODEL || "htdemucs_6s";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const jobs = new Map();

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(JOB_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_req, _file, callback) =>
      callback(null, `${crypto.randomUUID()}.mp3`),
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== ".mp3") {
      const error = new Error("Please upload an MP3 file.");
      error.statusCode = 400;
      return callback(error);
    }
    callback(null, true);
  },
});

const allowedStems = new Set(["vocals", "guitar", "bass", "drums"]);

function publicJob(job) {
  return {
    jobId: job.id,
    progress: job.progress,
    done: job.done,
    error: job.error || null,
    message: job.message,
    filename: job.filename || null,
  };
}

function updateJob(job, values) {
  Object.assign(job, values);
  for (const client of job.clients) {
    client.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);
  }
}

function parseProgress(text) {
  // Demucs output often reports tqdm progress using carriage returns.
  const matches = [...text.matchAll(/(\d{1,3})%/g)];
  if (!matches.length) return null;
  const value = Number(matches[matches.length - 1][1]);
  return Number.isFinite(value) ? Math.max(0, Math.min(99, value)) : null;
}

function spawnLogged(command, args, onOutput, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let combined = "";

    const capture = (chunk) => {
      const text = chunk.toString();
      combined += text;
      if (combined.length > 100_000) combined = combined.slice(-100_000);
      onOutput(text);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) =>
      reject(
        new Error(
          `Could not start "${command}". Confirm it is installed or configure its path. ${error.message}`,
        ),
      ),
    );
    child.once("close", (code, signal) => {
      if (code === 0) return resolve(combined);
      reject(
        new Error(
          `${command} exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.\n${combined.slice(-5000)}`,
        ),
      );
    });
  });
}

async function processJob(job) {
  const jobRoot = path.join(JOB_DIR, job.id);
  const separatedRoot = path.join(jobRoot, "separated");
  const outputPath = path.join(jobRoot, job.filename);
  await fsp.mkdir(separatedRoot, { recursive: true });

  try {
    updateJob(job, { progress: 1, message: "Starting Demucs separation…" });
    console.log(`[${job.id}] Running ${MODEL} using ${DEMUCS_PATH}`);

    await spawnLogged(
      DEMUCS_PATH,
      ["-n", MODEL, "-o", separatedRoot, job.inputPath],
      (chunk) => {
        const text = chunk.toString();
        console.log(`[Demucs ${job.id}] ${text.trimEnd()}`);
        const progress = parseProgress(text);
        if (progress !== null) {
          // Separation progress is approximate; reserve final 10% for mixing.
          updateJob(job, {
            progress: Math.max(
              job.progress,
              Math.min(89, Math.round(progress * 0.89)),
            ),
            message: `Separating audio… ${Math.min(89, Math.round(progress * 0.89))}%`,
          });
        }
      },
    );

    const songName = path.parse(job.inputOriginalName).name;
    const stemDirectory = path.join(
      separatedRoot,
      MODEL,
      path.basename(job.inputPath, path.extname(job.inputPath)),
    );
    let actualStemDirectory = stemDirectory;

    // Demucs names the output folder after the input file stem. Since uploads
    // are UUIDs, locate the generated model output folder defensively.
    try {
      await fsp.access(actualStemDirectory);
    } catch {
      const modelDir = path.join(separatedRoot, MODEL);
      const children = await fsp
        .readdir(modelDir, { withFileTypes: true })
        .catch(() => []);
      const candidate = children.find((entry) => entry.isDirectory());
      if (!candidate)
        throw new Error(`Could not locate Demucs output under ${modelDir}`);
      actualStemDirectory = path.join(modelDir, candidate.name);
    }

    const stemFiles = {
      vocals: "vocals.wav",
      guitar: "guitar.wav",
      bass: "bass.wav",
      drums: "drums.wav",
    };
    const retainedNames = [
      "drums.wav",
      "bass.wav",
      "other.wav",
      "vocals.wav",
      "guitar.wav",
      "piano.wav",
    ].filter((name) => name !== stemFiles[job.stem]);

    const retained = [];
    for (const name of retainedNames) {
      const filePath = path.join(actualStemDirectory, name);
      try {
        await fsp.access(filePath);
        retained.push(filePath);
      } catch {}
    }
    if (!retained.length)
      throw new Error("Demucs did not produce any stems to mix.");

    updateJob(job, { progress: 91, message: "Mixing the remaining stems…" });
    const args = ["-y"];
    for (const filePath of retained) args.push("-i", filePath);
    const inputs = retained.map((_file, index) => `[${index}:a]`).join("");
    const filter = `${inputs}amix=inputs=${retained.length}:duration=longest:dropout_transition=0:normalize=0[mix]`;

    args.push(
      "-filter_complex",
      filter,
      "-map",
      "[mix]",
      "-vn",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "192k",
      outputPath,
    );

    await spawnLogged(FFMPEG_PATH, args, (chunk) => {
      console.log(`[FFmpeg ${job.id}] ${chunk.toString().trimEnd()}`);
    });

    const stat = await fsp.stat(outputPath);
    if (!stat.size) throw new Error("FFmpeg created an empty output file.");

    updateJob(job, {
      progress: 100,
      done: true,
      message: "Processing complete.",
    });
    console.log(`[${job.id}] Complete: ${outputPath}`);
  } catch (error) {
    console.error(`[${job.id}] Processing failed:`, error.message);
    updateJob(job, {
      done: true,
      error: "Audio processing failed. Check the server terminal for details.",
      message: error.message,
    });
  } finally {
    await fsp.unlink(job.inputPath).catch(() => {});
    // Keep the completed result temporarily for download; remove after 30 minutes.
    setTimeout(
      async () => {
        await fsp.rm(jobRoot, { recursive: true, force: true }).catch(() => {});
        jobs.delete(job.id);
      },
      30 * 60 * 1000,
    ).unref();
  }
}

app.use(express.static(publicDirectory));

app.get("/", (_req, res) =>
  res.sendFile(path.join(publicDirectory, "index.html")),
);

app.post("/api/jobs", (req, res, next) => {
  upload.single("audio")(req, res, (uploadError) => {
    if (uploadError) return next(uploadError);
    if (!req.file)
      return res.status(400).json({ error: "Please upload an MP3 file." });

    const stem = req.body.stem;
    if (!allowedStems.has(stem)) {
      fsp.unlink(req.file.path).catch(() => {});
      return res
        .status(400)
        .json({ error: "Choose voice, guitars, bass, or drums to remove." });
    }

    const id = crypto.randomUUID();
    const baseName =
      path
        .parse(req.file.originalname)
        .name.replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 70) || "audio";
    const filename = `${baseName}-without-${stem}.mp3`;
    const job = {
      id,
      inputPath: req.file.path,
      inputOriginalName: req.file.originalname,
      stem,
      filename,
      progress: 0,
      done: false,
      error: null,
      message: "Queued for processing…",
      clients: new Set(),
    };
    jobs.set(id, job);
    res.status(202).json({ jobId: id });
    processJob(job).catch((error) => {
      console.error(`[${id}] Unexpected processing failure:`, error);
      updateJob(job, {
        done: true,
        error: "Unexpected audio processing error.",
        message: error.message,
      });
    });
  });
});

app.get("/api/progress/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found or expired." });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  job.clients.add(res);
  res.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);

  req.on("close", () => job.clients.delete(res));
});

app.get("/api/download/:id", async (req, res, next) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found or expired." });
  if (!job.done || job.error)
    return res.status(409).json({ error: "The output is not ready." });

  const filePath = path.join(JOB_DIR, job.id, job.filename);
  try {
    await fsp.access(filePath);
    res.download(filePath, job.filename);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res
      .status(413)
      .json({
        error: "The MP3 is too large. The maximum upload size is 100 MB.",
      });
  }
  const status = error.statusCode || 500;
  console.error("[StemCut]", error.message);
  res.status(status).json({
    error:
      status === 500
        ? "Server error. Check the terminal for details."
        : error.message,
  });
});

app.listen(PORT, () => {
  console.log(`StemCut is running at http://localhost:${PORT}`);
  console.log(`Demucs executable: ${DEMUCS_PATH}`);
  console.log(`Demucs model: ${MODEL}`);
  console.log(`FFmpeg executable: ${FFMPEG_PATH}`);
});
