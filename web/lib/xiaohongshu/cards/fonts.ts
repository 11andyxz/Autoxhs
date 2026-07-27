/**
 * 卡片渲染用的自带中文字体。
 *
 * 为什么要自带：本机（macOS）实测没有 PingFang SC，也没有任何重字重中文字体
 * —— 只有 Heiti SC / Songti SC / Hiragino Sans GB。写 font-weight:800 时浏览器
 * 会做「合成加粗」，笔画粘连，放大到 1440px 很难看。所以把两套 SIL OFL 开源字体
 * 打进 repo，保证换机器 / 重装系统渲染结果完全一致。
 *
 * 字体（均为 SIL Open Font License 1.1，授权正本在同目录）：
 *  - SmileySans-Oblique（得意黑）：斜体展示字，做大标题，冲击力强
 *  - NotoSansSC Regular / Bold：正文与要点
 *
 * 内联成 base64 而不是 file:// 引用：puppeteer 用 setContent 时页面 origin 是
 * about:blank，Chrome 默认禁止它去读 file:// 子资源；内联可以完全避开这个问题，
 * 也不需要给 Chrome 开 --allow-file-access-from-files。三个文件共 3.3MB，
 * 进程内缓存一次，后续渲染零开销。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** 字体目录。可用 XHS_CARDS_FONT_DIR 覆盖（部署路径不同时用）。 */
function fontDir(): string {
  const override = process.env.XHS_CARDS_FONT_DIR?.trim();
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), "assets", "cards-fonts");
}

const FILES = {
  display: "SmileySans-Oblique.woff2",
  sansRegular: "NotoSansSC-Regular.woff2",
  sansBold: "NotoSansSC-Bold.woff2",
} as const;

/** 本机字体文件缺失时抛出，路由层映射为 503（跟 ChromeNotFoundError 一个待遇）。 */
export class FontsMissingError extends Error {
  constructor(missing: string[]) {
    super(`卡片字体文件缺失：${missing.join("、")}`);
    this.name = "FontsMissingError";
  }
}

let cached: string | null = null;

/**
 * 生成可直接塞进 <style> 的 @font-face 片段。进程内只读盘一次。
 * 字体族名固定为 XhsDisplay / XhsSans，layouts/template 里引用这两个名字。
 */
export async function fontFaceCss(): Promise<string> {
  if (cached) return cached;

  const dir = fontDir();
  const entries = Object.entries(FILES) as Array<[keyof typeof FILES, string]>;
  const loaded: Partial<Record<keyof typeof FILES, string>> = {};
  const missing: string[] = [];

  for (const [key, filename] of entries) {
    try {
      const buf = await fs.readFile(path.join(dir, filename));
      loaded[key] = buf.toString("base64");
    } catch {
      missing.push(filename);
    }
  }
  if (missing.length) throw new FontsMissingError(missing);

  const face = (family: string, weight: number, style: string, b64: string) =>
    `@font-face{font-family:'${family}';font-weight:${weight};font-style:${style};font-display:block;` +
    `src:url(data:font/woff2;base64,${b64}) format('woff2');}`;

  cached = [
    // 得意黑本身就是斜体设计，声明成 normal，避免浏览器再叠一次倾斜
    face("XhsDisplay", 700, "normal", loaded.display as string),
    face("XhsSans", 400, "normal", loaded.sansRegular as string),
    face("XhsSans", 700, "normal", loaded.sansBold as string),
  ].join("\n");
  return cached;
}

/** 测试用：清掉进程内缓存。 */
export function resetFontCache(): void {
  cached = null;
}
