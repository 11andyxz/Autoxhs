/**
 * 幻灯片渲染:用本机 Chrome(puppeteer-core,复用 Word→PDF 那套 Chrome 定位)把每个镜头渲染成
 * 一张 1080×1920 竖版 PNG 帧 —— 笔记原图铺满上方 + 底部字幕条(caption)。
 *
 * 用 page.screenshot() 栅格化(不是 page.pdf()):中文用系统 PingFang 直接渲染即可,
 * 不涉及 PDF 的字体嵌入问题,所以无需 Word→PDF 里那套字体归一化。
 */
import fs from "node:fs";

import puppeteer from "puppeteer-core";

import { resolveChromePath, ChromeNotFoundError } from "@/lib/pdfTools/wordToPdf";

export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;

export type SlideSpec = {
  /** 图片 data URL;为 null 时用纯色背景兜底 */
  imageDataUrl: string | null;
  /** 顶部小标签(该分镜的要点/关键词,整段持续显示) */
  topLabel?: string;
  /** 底部逐句字幕(当前正在念的这一句) */
  subtitle?: string;
  /** 右下角账号水印 */
  handle?: string;
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 单张幻灯片的完整 HTML(自包含,尺寸固定 1080×1920):图片满屏 + 顶部要点标签 + 底部逐句字幕。 */
export function buildSlideHtml(spec: SlideSpec): string {
  const bg = spec.imageDataUrl
    ? `background-image:url('${spec.imageDataUrl}');background-size:cover;background-position:center;`
    : "background:linear-gradient(135deg,#ff2e51,#ff7a59);";
  const topLabel = spec.topLabel
    ? `<div class="top"><span>${esc(spec.topLabel)}</span></div>`
    : "";
  const subtitle = spec.subtitle
    ? `<div class="sub">${esc(spec.subtitle)}</div>`
    : "";
  const handle = spec.handle ? `<div class="handle">${esc(spec.handle)}</div>` : "";

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: light; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${VIDEO_WIDTH}px; height:${VIDEO_HEIGHT}px; overflow:hidden; }
  .stage {
    position:relative; width:${VIDEO_WIDTH}px; height:${VIDEO_HEIGHT}px;
    background:#111; ${bg}
    font-family:"PingFang SC","Heiti SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  }
  /* 顶部/底部渐变遮罩,保证文字在任意图片上都清晰 */
  .stage::before {
    content:""; position:absolute; inset:0;
    background:linear-gradient(180deg, rgba(0,0,0,.5) 0%, rgba(0,0,0,0) 20%, rgba(0,0,0,0) 48%, rgba(0,0,0,.82) 100%);
  }
  .top {
    position:absolute; top:80px; left:64px; right:64px; z-index:2;
  }
  .top span {
    display:inline-block; background:rgba(255,46,81,.92); color:#fff;
    font-size:48px; font-weight:800; line-height:1.35; padding:12px 24px; border-radius:16px;
    box-shadow:0 6px 24px rgba(0,0,0,.25);
  }
  /* 底部逐句字幕:大号白字 + 描边,居中,压在下方字幕区 */
  .sub {
    position:absolute; left:56px; right:56px; bottom:200px; z-index:2;
    text-align:center;
    color:#fff; font-size:66px; font-weight:800; line-height:1.35;
    letter-spacing:.5px;
    text-shadow:0 3px 16px rgba(0,0,0,.7);
    -webkit-text-stroke:2px rgba(0,0,0,.55);
    paint-order:stroke fill;
  }
  .handle {
    position:absolute; right:56px; bottom:110px; z-index:2;
    color:rgba(255,255,255,.9); font-size:34px; font-weight:600;
    text-shadow:0 2px 10px rgba(0,0,0,.6);
  }
</style>
</head>
<body>
  <div class="stage">${topLabel}${subtitle}${handle}</div>
</body>
</html>`;
}

/**
 * 逐张渲染幻灯片为 PNG。只启动一次 Chrome、串行截图(还原可靠、开销小)。
 * 本机没有 Chrome 时抛 ChromeNotFoundError(由路由层映射为 503)。
 */
export async function renderSlides(specs: SlideSpec[]): Promise<Buffer[]> {
  const executablePath = resolveChromePath(
    (p) => fs.existsSync(p),
    process.env.CHROME_EXECUTABLE_PATH,
  );
  if (!executablePath) throw new ChromeNotFoundError();

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--disable-gpu", "--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: VIDEO_WIDTH, height: VIDEO_HEIGHT, deviceScaleFactor: 1 });
    const frames: Buffer[] = [];
    for (const spec of specs) {
      await page.setContent(buildSlideHtml(spec), { waitUntil: "load", timeout: 30_000 });
      // 等字体与背景图解码就绪,避免截到半成品
      await page.evaluate(
        () => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready,
      );
      const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: VIDEO_WIDTH, height: VIDEO_HEIGHT } });
      frames.push(Buffer.from(png));
    }
    return frames;
  } finally {
    await browser.close();
  }
}
