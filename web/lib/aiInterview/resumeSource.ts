import { readFile } from "node:fs/promises";
import path from "node:path";

import { extractTextFromFile } from "@/lib/job-hunter/parse";

import { LIMITS } from "./schema";

/**
 * 「默认简历」的唯一来源。
 *
 * 浏览器版(/api/ai-interview/resume-text)和桌面端(/api/ai-interview/desktop/context)
 * 都要这份文本,文件名只能有一处 —— 换简历时改一个地方。
 *
 * 放在 assets/ 而不是 public/:这份 docx 里有手机号和邮箱,不能被公网直接下载。
 */
export const DEFAULT_RESUME_FILE = "Andy_Xiong_Senior_Backend_Java_Developer.docx";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type DefaultResume = { text: string; name: string };

/** 读默认简历并转成纯文本;文件不在就回 null(调用方给出「请手动上传」)。 */
export async function readDefaultResume(): Promise<DefaultResume | null> {
  const buf = await readFile(
    path.join(process.cwd(), "assets", "default-resume", DEFAULT_RESUME_FILE),
  ).catch(() => null);
  if (!buf) return null;

  const file = new File([new Uint8Array(buf)], DEFAULT_RESUME_FILE, { type: DOCX_MIME });
  const text = await extractTextFromFile(file);
  return { text: text.slice(0, LIMITS.resume), name: DEFAULT_RESUME_FILE };
}
