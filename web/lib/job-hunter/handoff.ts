import type { JobHunterResult } from "@/lib/job-hunter/schema";

/**
 * 求职神器 → 一键投递 的客户端交接通道。
 *
 * 定制结果只存在于浏览器（不落盘、不入库），因此这里用 sessionStorage 把
 * 「定制简历 + JD」从 /job-hunter 带到 /indeed；关标签页即失效，符合本工具的纯前端状态约定。
 */

const HANDOFF_KEY = "autoxhs:jobhunter-handoff";

// 简历 PDF 走浏览器打印，不在此列；这里是服务端 /api/job-hunter/export 导出的文件类型。
export type ResumeExportKind = "resume-docx" | "cover-pdf" | "analysis-pdf";

export type ResumeHandoff = {
  result: JobHunterResult;
  jdText: string;
  savedAt: number;
};

export function saveHandoff(h: ResumeHandoff): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(h));
  } catch {
    /* sessionStorage 不可用（隐私模式 / 超额）时静默降级 */
  }
}

export function readHandoff(): ResumeHandoff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ResumeHandoff;
    if (!parsed?.result?.resume) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearHandoff(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    /* ignore */
  }
}

export function resumeExportFilename(kind: ResumeExportKind, result: JobHunterResult): string {
  const name = result.resume.name.trim().replace(/\s+/g, "_") || "candidate";
  switch (kind) {
    case "resume-docx":
      return `Resume_${name}.docx`;
    case "cover-pdf":
      return `Cover_Letter_${name}.pdf`;
    case "analysis-pdf":
      return "Match_Report.pdf";
  }
}
