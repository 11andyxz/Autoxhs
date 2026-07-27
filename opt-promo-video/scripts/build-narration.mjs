import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const segmentDuration = 15;
const speechTarget = 13.4;
const voice = "Flo (中文（中国大陆）)";
const rate = "160";
const assetDir = path.join(cwd, "assets", "narration");
const buildDir = path.join(assetDir, "build");
const ffmpeg = path.join(cwd, "bin", "ffmpeg");
const ffprobe = path.join(cwd, "bin", "ffprobe");
const segments = JSON.parse(readFileSync(path.join(assetDir, "segments.json"), "utf8"));

mkdirSync(buildDir, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function duration(file) {
  const output = execFileSync(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ], { encoding: "utf8" });
  return Number.parseFloat(output.trim());
}

const finalSegments = [];

segments.forEach((text, index) => {
  const id = String(index + 1).padStart(2, "0");
  const textFile = path.join(buildDir, `segment-${id}.txt`);
  const rawFile = path.join(buildDir, `segment-${id}.aiff`);
  const wavFile = path.join(buildDir, `segment-${id}.wav`);

  writeFileSync(textFile, text);
  run("say", ["-v", voice, "-r", rate, "-o", rawFile, "-f", textFile]);

  const rawDuration = duration(rawFile);
  const tempo = Math.max(1, Math.min(1.9, rawDuration / speechTarget));
  run(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    rawFile,
    "-af",
    `atempo=${tempo.toFixed(3)},apad,atrim=0:${segmentDuration}`,
    "-ar",
    "48000",
    "-ac",
    "2",
    wavFile,
  ]);

  const finalDuration = duration(wavFile);
  finalSegments.push(wavFile);
  console.log(`segment ${id}: raw=${rawDuration.toFixed(2)}s tempo=${tempo.toFixed(3)} final=${finalDuration.toFixed(2)}s`);
});

const concatFile = path.join(buildDir, "concat.txt");
writeFileSync(concatFile, finalSegments.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));

const outputFile = path.join(assetDir, "opt-narration.wav");
run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", outputFile]);
console.log(`narration: ${outputFile} ${duration(outputFile).toFixed(2)}s`);
