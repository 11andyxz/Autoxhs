/**
 * 用本机 Chrome（puppeteer-core，复用 Word→PDF 那套 Chrome 定位）把整叠卡片渲染成
 * 1440×1920 PNG。
 *
 * 关键点：
 *  - 一次 setContent 载入整叠，逐个 .card 元素截图 —— 字体只解码一次，8 张≈1 张的耗时
 *  - deviceScaleFactor=2：CSS 里按 720×960 排版，出图 1440×1920（3:4，小红书流量最高比例）
 *  - 等 document.fonts.ready 再等 window.__fitDone，避免截到「字体没换上」或「还没缩字号」的半成品
 *  - 全程本地、无网络请求，同一份 outline 渲染两次得到同一张图
 */
import fs from "node:fs";

import puppeteer from "puppeteer-core";

import { ChromeNotFoundError, resolveChromePath } from "@/lib/pdfTools/wordToPdf";

import { buildDeckHtml } from "./template";
import { CARD_HEIGHT, CARD_WIDTH, CSS_HEIGHT, CSS_WIDTH, type CardOutline } from "./types";

export type RenderedCard = {
  index: number;
  png: Buffer;
  /** 降到字号下限仍装不下 —— UI 据此提示「文字过长，建议精简」 */
  overflow: boolean;
};

const NAV_TIMEOUT_MS = 60_000;
const FIT_TIMEOUT_MS = 20_000;

/**
 * 渲染卡片。only 传下标时只截那一张（用于「重生成这张」，约 1~2 秒）。
 * 本机没有 Chrome 时抛 ChromeNotFoundError；字体缺失时 buildDeckHtml 抛 FontsMissingError。
 * 两者都由路由层映射为 503。
 */
export async function renderCards(
  outline: CardOutline,
  only?: number,
): Promise<RenderedCard[]> {
  if (outline.cards.length === 0) return [];
  if (only !== undefined && (only < 0 || only >= outline.cards.length)) {
    throw new Error(`卡片下标越界：${only}`);
  }

  // 先拼 HTML（可能抛 FontsMissingError），再启动 Chrome，避免白开一次浏览器
  const html = await buildDeckHtml(outline);

  const executablePath = resolveChromePath(
    (p) => fs.existsSync(p),
    process.env.CHROME_EXECUTABLE_PATH,
  );
  if (!executablePath) throw new ChromeNotFoundError();

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--disable-gpu", "--no-sandbox", "--font-render-hinting=none"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: CSS_WIDTH,
      height: CSS_HEIGHT,
      deviceScaleFactor: CARD_WIDTH / CSS_WIDTH,
    });
    await page.setContent(html, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    await page.evaluate(
      () => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready,
    );
    // 自适应脚本跑完才截图，否则会截到未缩字号的溢出版本
    await page.waitForFunction("window.__fitDone === true", { timeout: FIT_TIMEOUT_MS });

    const targets = only === undefined ? outline.cards.map((_, i) => i) : [only];
    const out: RenderedCard[] = [];
    for (const index of targets) {
      const handle = await page.$(`.card[data-idx="${index}"]`);
      if (!handle) throw new Error(`未找到第 ${index + 1} 张卡片的节点`);
      const overflow = await handle.evaluate((el) => el.getAttribute("data-overflow") === "1");
      const png = await handle.screenshot({ type: "png" });
      out.push({ index, png: Buffer.from(png), overflow });
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** 出图物理尺寸，写进发布 body 的 image_info 时如实上报。 */
export const OUTPUT_SIZE = { width: CARD_WIDTH, height: CARD_HEIGHT } as const;
