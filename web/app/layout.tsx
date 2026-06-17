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
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
