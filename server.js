const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const app = express();
const PORT = 3000;
const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;
const MIN_BOX_SIZE = 8;

const uploadDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

app.use(express.static("public"));
app.use("/output", express.static(outputDir));

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
        const safeName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
        cb(null, safeName);
    }
});

const upload = multer({ storage });

function parsePositiveInteger(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInteger(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        console.log("Running FFmpeg:");
        console.log("ffmpeg " + args.join(" "));

        execFile("ffmpeg", args, (error, stdout, stderr) => {
            if (error) {
                console.error("FFmpeg error:");
                console.error(stderr);
                reject(new Error(stderr || error.message));
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

function probeVideoDimensions(inputPath) {
    return new Promise((resolve, reject) => {
        execFile(
            "ffprobe",
            [
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "json",
                inputPath
            ],
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                    return;
                }

                try {
                    const data = JSON.parse(stdout);
                    const stream = data.streams && data.streams[0];
                    const width = parsePositiveInteger(stream && stream.width);
                    const height = parsePositiveInteger(stream && stream.height);

                    if (!width || !height) {
                        reject(new Error("Could not read video dimensions."));
                        return;
                    }

                    resolve({ width, height });
                } catch (parseError) {
                    reject(parseError);
                }
            }
        );
    });
}

async function getVideoDimensions(inputPath, body) {
    try {
        return await probeVideoDimensions(inputPath);
    } catch (error) {
        const width = parsePositiveInteger(body.videoWidth);
        const height = parsePositiveInteger(body.videoHeight);

        if (width && height) {
            return { width, height };
        }

        throw new Error("Could not read video size. Make sure ffprobe is installed with FFmpeg.");
    }
}

function hasNvenc() {
    return new Promise((resolve) => {
        execFile("ffmpeg", ["-hide_banner", "-encoders"], (error, stdout, stderr) => {
            if (error) return resolve(false);

            const output = stdout + stderr;
            resolve(output.toLowerCase().includes("h264_nvenc"));
        });
    });
}

function normalizeRemovalBox(box, dimensions) {
    const maxX = Math.max(1, dimensions.width - MIN_BOX_SIZE - 1);
    const maxY = Math.max(1, dimensions.height - MIN_BOX_SIZE - 1);
    const x = clamp(Math.round(box.x), 1, maxX);
    const y = clamp(Math.round(box.y), 1, maxY);
    const maxWidth = Math.max(MIN_BOX_SIZE, dimensions.width - x - 1);
    const maxHeight = Math.max(MIN_BOX_SIZE, dimensions.height - y - 1);
    const w = clamp(Math.round(box.w), MIN_BOX_SIZE, maxWidth);
    const h = clamp(Math.round(box.h), MIN_BOX_SIZE, maxHeight);

    return { x, y, w, h };
}

function getManualRemovalBox(body, dimensions) {
    const x = parseNonNegativeInteger(body.maskX);
    const y = parseNonNegativeInteger(body.maskY);
    const w = parsePositiveInteger(body.maskW);
    const h = parsePositiveInteger(body.maskH);

    if (x === null || y === null || !w || !h || w < MIN_BOX_SIZE || h < MIN_BOX_SIZE) {
        return null;
    }

    return normalizeRemovalBox({ x, y, w, h }, dimensions);
}

function getAutoRemovalBox(body, dimensions) {
    const position = [
        "bottom-right",
        "bottom-left",
        "top-right",
        "top-left"
    ].includes(body.autoPosition)
        ? body.autoPosition
        : "bottom-right";
    const w = Math.round(dimensions.width * 0.24);
    const h = Math.round(dimensions.height * 0.13);
    const marginX = Math.round(dimensions.width * 0.03);
    const marginY = Math.round(dimensions.height * 0.04);
    const x = position.endsWith("right")
        ? dimensions.width - w - marginX
        : marginX;
    const y = position.startsWith("bottom")
        ? dimensions.height - h - marginY
        : marginY;

    return normalizeRemovalBox({ x, y, w, h }, dimensions);
}

function getRemovalBox(body, dimensions) {
    if (body.removalMode === "manual") {
        const manualBox = getManualRemovalBox(body, dimensions);

        if (!manualBox) {
            throw new Error("Draw a box around the watermark before using manual mode.");
        }

        return manualBox;
    }

    return getAutoRemovalBox(body, dimensions);
}

function buildVideoFilter(removalBox) {
    return [
        `delogo=x=${removalBox.x}:y=${removalBox.y}:w=${removalBox.w}:h=${removalBox.h}:show=0`,
        `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`
    ].join(",");
}

app.post("/process", upload.single("video"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send("No video uploaded");
        }

        const inputPath = req.file.path;
        const outputName = "processed-" + path.parse(req.file.filename).name + ".mp4";
        const outputPath = path.join(outputDir, outputName);

        const userWantsGpu = req.body.gpu === "on";
        const nvencAvailable = await hasNvenc();
        const dimensions = await getVideoDimensions(inputPath, req.body);
        const removalBox = getRemovalBox(req.body, dimensions);
        const videoFilter = buildVideoFilter(removalBox);

        let args;

        if (userWantsGpu && nvencAvailable) {
            args = [
                "-y",
                "-i", inputPath,
                "-vf", videoFilter,
                "-c:v", "h264_nvenc",
                "-preset", "p4",
                "-b:v", "8M",
                "-c:a", "aac",
                "-b:a", "192k",
                outputPath
            ];
        } else {
            args = [
                "-y",
                "-i", inputPath,
                "-vf", videoFilter,
                "-c:v", "libx264",
                "-preset", "medium",
                "-crf", "20",
                "-c:a", "aac",
                "-b:a", "192k",
                outputPath
            ];
        }

        try {
            await runFfmpeg(args);
        } catch (gpuError) {
            if (userWantsGpu) {
                console.log("GPU failed. Trying CPU fallback...");

                const cpuArgs = [
                    "-y",
                    "-i", inputPath,
                    "-vf", videoFilter,
                    "-c:v", "libx264",
                    "-preset", "medium",
                    "-crf", "20",
                    "-c:a", "aac",
                    "-b:a", "192k",
                    outputPath
                ];

                await runFfmpeg(cpuArgs);
            } else {
                throw gpuError;
            }
        }

        res.send(`
      <h2>Video Processed Successfully</h2>

      <video width="720" controls>
        <source src="/output/${escapeHtml(outputName)}" type="video/mp4">
      </video>

      <br><br>

      <a href="/output/${escapeHtml(outputName)}" download>
        Download Processed Video
      </a>

      <br><br>

      <a href="/">
        Go Back
      </a>
    `);
    } catch (error) {
        console.error(error);

        res.status(500).send(`
      <h2>Video processing failed</h2>
      <p>Check the terminal window for the full FFmpeg error.</p>
      <pre>${String(error.message).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
      <a href="/">Go Back</a>
    `);
    }
});

app.listen(PORT, () => {
    console.log(`Local video tool running at http://localhost:${PORT}`);
});
