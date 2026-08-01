import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { queryTerms, scoreText, pickExcerpt } from "./codeRank";

/**
 * 「结合我的项目」的**代码佐证**:从本机一个代码库里挑出与这道题最相关的几段真实代码,
 * 连同文件树一起喂给模型,让简历版回答能贴上自己写的代码。
 *
 * 这个模块会**读本机文件并把内容发给 OpenAI**,所以守卫比功能本身还重要:
 *  - 公网模式(NEXT_PUBLIC_DEPLOY_MODE=public)整体关闭 —— `/api/job-hunter/*` 在公网白名单里,
 *    绝不能变成一个「任意本地文件读取」的口子;
 *  - 路径必须是**绝对路径 + 目录 + realpath 后仍在允许根目录内**(软链也逃不出去);
 *  - 只读代码/配置类扩展名,跳过 .env/密钥/证书这类文件,跳过 node_modules/target 等目录;
 *  - 文件数、单文件大小、总读取量、喂给模型的字符数都有硬上限。
 * 纯打分逻辑在 codeRank.ts(可单测,不碰 fs)。
 */

export class CodePathError extends Error {}

/** 公网部署时整体关掉本地代码读取。 */
export const CODE_CONTEXT_DISABLED = process.env.NEXT_PUBLIC_DEPLOY_MODE === "public";

/** 允许的根目录:默认取仓库根(web/ 的上一级),可用 CRAM_CODE_ROOT 覆盖。 */
export function allowedCodeRoot(): string {
  const configured = process.env.CRAM_CODE_ROOT?.trim();
  return path.resolve(configured || path.join(process.cwd(), ".."));
}

/** target 在 dir 之内(或就是 dir)。两边都必须先 realpath,否则软链能绕过。 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".next-verify", ".next-public", "target", "build", "dist", "out",
  "coverage", "vendor", ".venv", "venv", "__pycache__", ".idea", ".vscode", ".gradle", ".mvn",
  ".terraform", "bin", "obj", ".cache", "tmp",
]);

const CODE_EXTS = new Set([
  ".java", ".kt", ".scala", ".groovy", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go",
  ".rb", ".rs", ".cs", ".php", ".c", ".h", ".cpp", ".hpp", ".sql", ".yml", ".yaml", ".xml", ".json",
  ".properties", ".conf", ".toml", ".gradle", ".proto", ".tf", ".sh", ".md",
]);

/** 一眼就不该读、更不该发给模型的东西(密钥/证书/凭据/锁文件)。 */
const SECRET_RE = /(^\.env)|(^id_(rsa|ed25519))|(credential)|(secret)|(\.pem$)|(\.key$)|(\.p12$)|(\.jks$)|(\.keystore$)|(\.pfx$)|(lock$)/i;

export function isCodeFile(name: string): boolean {
  if (name.startsWith(".")) return false;
  if (SECRET_RE.test(name)) return false;
  return CODE_EXTS.has(path.extname(name).toLowerCase());
}

export function isSkippedDir(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

const MAX_FILES = 4000; // 扫描到的候选文件上限
const MAX_FILE_BYTES = 200_000; // 单个文件超过就跳过(生成的大文件没有讲解价值)
const MAX_TOTAL_READ = 8_000_000; // 一次请求读盘总量上限
const TOP_FILES = 5; // 喂给模型的文件数
const MAX_EXCERPT = 4000; // 每个文件喂多少字符
const MAX_TREE_ENTRIES = 220; // 文件树列多少条

/**
 * 校验并规整用户填的代码库路径。返回 realpath 后的绝对路径;不合法抛 CodePathError(消息给用户看)。
 */
export async function resolveCodeDir(input: string): Promise<string> {
  if (CODE_CONTEXT_DISABLED) throw new CodePathError("公网模式下不支持读取本机代码库。");
  const raw = input.trim();
  if (!raw) throw new CodePathError("请填代码库的绝对路径。");
  if (!path.isAbsolute(raw)) throw new CodePathError("请填绝对路径（以 / 开头）。");
  let real: string;
  try {
    real = await realpath(raw);
  } catch {
    throw new CodePathError("这个路径不存在或读不到。");
  }
  const st = await stat(real);
  if (!st.isDirectory()) throw new CodePathError("请填一个目录，不是单个文件。");
  const root = await realpath(allowedCodeRoot()).catch(() => allowedCodeRoot());
  if (!isInside(root, real)) throw new CodePathError(`只能用 ${root} 下面的目录（可用 CRAM_CODE_ROOT 改）。`);
  return real;
}

async function walk(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (isSkippedDir(e.name)) continue;
      await walk(full, out);
    } else if (e.isFile() && isCodeFile(e.name)) {
      out.push(full);
    }
  }
}

export type CodeContext = {
  /** 相对路径清单(压缩过),让模型知道这个仓库长什么样。 */
  tree: string;
  /** 挑出来的几段真实代码,已带路径与行号。 */
  excerpts: string;
  /** 实际入选的文件(相对路径),用于日志/调试。 */
  picked: string[];
};

/**
 * 按「问题 + 原答案」的关键词从代码库里挑最多 TOP_FILES 个文件,截出最相关的一段。
 * 挑不出东西就返回 null(路由据此完全不提代码,不会硬凑)。
 */
export async function collectCodeContext(dir: string, query: string): Promise<CodeContext | null> {
  if (CODE_CONTEXT_DISABLED) return null;
  const terms = queryTerms(query);
  if (!terms.length) return null;

  const files: string[] = [];
  await walk(dir, files);
  if (!files.length) return null;

  const tree = files
    .slice(0, MAX_TREE_ENTRIES)
    .map((f) => path.relative(dir, f))
    .sort()
    .join("\n");

  let readBytes = 0;
  const scored: Array<{ file: string; rel: string; content: string; score: number }> = [];
  for (const file of files) {
    if (readBytes >= MAX_TOTAL_READ) break;
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) continue;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    readBytes += size;
    const rel = path.relative(dir, file);
    const score = scoreText(terms, rel, content);
    if (score > 0) scored.push({ file, rel, content, score });
  }
  if (!scored.length) return null;

  scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  const top = scored.slice(0, TOP_FILES);
  const excerpts = top
    .map((f) => {
      const { text, startLine, endLine } = pickExcerpt(f.content, terms, MAX_EXCERPT);
      return `----- ${f.rel} (lines ${startLine}-${endLine}) -----\n${text}`;
    })
    .join("\n\n");

  return { tree, excerpts, picked: top.map((f) => f.rel) };
}
