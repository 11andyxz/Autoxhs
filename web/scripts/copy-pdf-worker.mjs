// 把 pdfjs 前端渲染所需的静态资源复制到 public/pdfjs/,供 /pdf-tools 以固定 URL 加载。
// 直接 new URL("pdfjs-dist/...", import.meta.url) 会和 serverExternalPackages 冲突;
// 且 pdf.js v6 渲染带 ICC 彩图的页面时要按 wasmUrl 取 qcms/openjpeg,取不到会挂起,
// 所以 worker + wasm + iccs + 标准字体 + cmaps 都要在。由 predev/prebuild 自动执行。
import { cpSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "node_modules", "pdfjs-dist");
const out = join(here, "..", "public", "pdfjs");

function newer(src, dest) {
  try {
    return statSync(dest).mtimeMs >= statSync(src).mtimeMs;
  } catch {
    return false;
  }
}

try {
  mkdirSync(out, { recursive: true });
  const workerSrc = join(pkg, "build", "pdf.worker.min.mjs");
  const workerDest = join(out, "pdf.worker.min.mjs");
  let copied = 0;
  if (!newer(workerSrc, workerDest)) {
    copyFileSync(workerSrc, workerDest);
    copied++;
  }
  for (const dir of ["wasm", "iccs", "standard_fonts", "cmaps"]) {
    const src = join(pkg, dir);
    const dest = join(out, dir);
    // 以目录里任意一个文件的时间戳粗略判断;不新则整目录同步
    if (!newer(src, dest)) {
      cpSync(src, dest, { recursive: true });
      copied++;
    }
  }
  if (copied > 0) console.log("[copy-pdf-worker] 已同步 pdfjs 静态资源 → public/pdfjs/");
} catch (err) {
  console.error("[copy-pdf-worker] 复制失败(PDF 工具箱前端将无法渲染 PDF):", err?.message);
}
