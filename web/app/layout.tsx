import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "小红书文案发表",
  description:
    "粘贴参考内容,AI 将为你重新组织语言、优化排版,并生成适合小红书发布的标题、正文和标签。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // suppressHydrationWarning: 容忍浏览器扩展(如沉浸式翻译)在 React 接管前往 <html> 注入属性,
  // 造成的 hydration 不一致(只豁免 <html> 自身属性,不影响子树)。
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
