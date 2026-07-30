import type { Viewport } from "next";

/**
 * 副屏视图专用的 viewport。
 *
 * viewportFit: "cover" 让页面铺满整个屏幕(包括灵动岛/刘海那一圈),同时把
 * env(safe-area-inset-*) 变成真实数值 —— 页面里再用它把内容推回安全区。
 * 不这么做的话,iPhone 横屏看这个页面时,灵动岛会压在左边的文字上(实测)。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#020617", // 和页面底色一致,免得顶部露出一条白边
};

export default function LiveViewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
