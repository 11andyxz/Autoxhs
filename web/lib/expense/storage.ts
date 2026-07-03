/**
 * 花费凭证的本地磁盘存储(仅服务器端,runtime="nodejs")。
 * 文件按 <root>/business-expense/<expenseId>/<filename> 归档,数据库只存元数据。
 * root 默认是项目目录下的 uploads/(已加入 .gitignore),沿用 employee 的约定,
 * 可用 EMPLOYEE_UPLOAD_DIR 覆盖(与雇员共用同一上传根,仅子目录不同)。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { sanitizeStoredFileName, fileExtension } from "./validate";

/** 上传根目录的绝对路径。默认 <cwd>/uploads(dev 下 cwd 即 web/)。 */
export function uploadsRoot(): string {
  const override = process.env.EMPLOYEE_UPLOAD_DIR?.trim();
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), "uploads");
}

function expenseRoot(): string {
  return path.join(uploadsRoot(), "business-expense");
}

/** 确保最终路径仍在 root 之内,杜绝路径穿越;不在则抛错。 */
function assertWithinRoot(absPath: string): string {
  const root = path.resolve(uploadsRoot());
  const resolved = path.resolve(absPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("非法的文件路径");
  }
  return resolved;
}

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** 根据扩展名给出可靠的 MIME(上传带来的 file.type 可能为空/不可信时回退)。 */
export function mimeForName(name: string, fallback?: string): string {
  return EXT_MIME[fileExtension(name)] ?? (fallback && fallback.trim() ? fallback : "application/octet-stream");
}

export interface SavedFile {
  storedName: string;
  /** 相对 uploadsRoot 的 POSIX 风格路径,存库用 */
  relativePath: string;
  absPath: string;
}

/**
 * 把凭证写入 <root>/business-expense/<expenseId>/<storedName>。
 * 同名文件自动加序号避免覆盖。返回落盘信息(失败抛错,由调用方回滚清理)。
 */
export async function saveExpenseFile(
  expenseId: number,
  originalName: string,
  data: Buffer,
): Promise<SavedFile> {
  const dir = path.join(expenseRoot(), String(expenseId));
  assertWithinRoot(dir);
  await fs.mkdir(dir, { recursive: true });

  const baseName = sanitizeStoredFileName(originalName);
  let storedName = baseName;
  const ext = fileExtension(baseName);
  const stem = ext ? baseName.slice(0, baseName.length - ext.length - 1) : baseName;
  for (let i = 2; ; i += 1) {
    const candidate = path.join(dir, storedName);
    try {
      await fs.access(candidate);
      // 已存在 -> 换名重试
      storedName = ext ? `${stem} (${i}).${ext}` : `${stem} (${i})`;
    } catch {
      break; // 不存在,可用
    }
  }

  const absPath = assertWithinRoot(path.join(dir, storedName));
  await fs.writeFile(absPath, data, { flag: "wx" });

  const relativePath = path.relative(uploadsRoot(), absPath).split(path.sep).join("/");
  return { storedName, relativePath, absPath };
}

/** 把存库的相对路径解析回绝对路径(并校验仍在 root 内)。 */
export function resolveStoredFile(relativePath: string): string {
  const abs = path.resolve(uploadsRoot(), relativePath);
  return assertWithinRoot(abs);
}

/** 尽力删除某文件(回滚时清理已落盘文件),忽略错误。 */
export async function removeFileSafe(absPath: string): Promise<void> {
  try {
    await fs.unlink(absPath);
  } catch {
    /* ignore */
  }
}

/**
 * 删除一批相对路径对应的文件,并尽力清掉该花费的空目录。
 * 用于删除花费/凭证后清理磁盘(DB 行已由 CASCADE 或直接删除处理)。忽略单个失败。
 */
export async function removeExpenseFilesByRelativePaths(relativePaths: string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const rel of relativePaths) {
    let abs: string;
    try {
      abs = resolveStoredFile(rel);
    } catch {
      continue; // 非法路径,跳过
    }
    await removeFileSafe(abs);
    dirs.add(path.dirname(abs));
  }
  // 尝试删掉现在为空的花费目录(非空会失败,直接忽略)
  for (const dir of dirs) {
    try {
      assertWithinRoot(dir);
      await fs.rmdir(dir);
    } catch {
      /* ignore */
    }
  }
}
