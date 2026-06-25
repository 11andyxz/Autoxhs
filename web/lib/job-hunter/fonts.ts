import path from "path";

import { Font } from "@react-pdf/renderer";

/**
 * 注册中文字体(Noto Sans SC),让 @react-pdf 能正确渲染中英文混排。
 * 字体文件随仓库一起提供在 lib/job-hunter/assets/fonts 下;运行时从 cwd 读取
 * (本项目以自托管方式运行 next dev / next start,cwd 即 web 目录)。
 */
export const PDF_FONT_FAMILY = "NotoSansSC";

let registered = false;

export function ensureFontRegistered(): void {
  if (registered) return;

  const dir = path.join(process.cwd(), "lib", "job-hunter", "assets", "fonts");
  Font.register({
    family: PDF_FONT_FAMILY,
    fonts: [
      { src: path.join(dir, "NotoSansSC-Regular.otf"), fontWeight: "normal" },
      { src: path.join(dir, "NotoSansSC-Bold.otf"), fontWeight: "bold" },
    ],
  });

  // CJK 不需要按拉丁语规则断词;原样返回避免把中文 / 单词拆坏
  Font.registerHyphenationCallback((word) => [word]);

  registered = true;
}
