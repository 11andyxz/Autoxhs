/** @type {import('next').NextConfig} */
const nextConfig = {
  // 构建目录可用 NEXT_DIST_DIR 覆盖，默认 `.next`。
  // 作用：同一 web 目录若要同时跑第二个 dev server（如做验证/预览），
  // 让它用独立的 `.next-verify`，物理隔离，避免两个 next dev 抢写同一个 `.next`
  // 导致产物损坏（ENOENT: .next/server/app/*/page.js 找不到）。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // 这两个包只在 Node API 路由里用，交给 Node 原生 require，
  // 避免被打包器处理（pdfjs 的可选 canvas 依赖、puppeteer 的动态 require 会报错）。
  serverExternalPackages: ["puppeteer-core", "pdfjs-dist"],
};

export default nextConfig;
