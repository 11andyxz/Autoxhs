/**
 * 生成视频的本地磁盘存储(仅服务器端)。
 * 文件存到 <uploadsRoot>/xhs-video/<id>.mp4;id 即对外句柄,file 路由据此回读。
 * uploadsRoot 复用雇员模块的约定(默认 <cwd>/uploads,已加入 .gitignore)。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { uploadsRoot } from "@/lib/employee/storage";

function videoDir(): string {
  return path.join(uploadsRoot(), "xhs-video");
}

/** 仅允许 [A-Za-z0-9_-],杜绝路径穿越;不合法返回 null。 */
export function sanitizeVideoId(id: string): string | null {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

/** 生成一个随机、文件系统安全的视频 id。 */
export function newVideoId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${rand}`;
}

/** 保存 mp4 字节,返回其 id。 */
export async function saveVideo(id: string, data: Buffer): Promise<void> {
  const dir = videoDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.mp4`), data);
}

/** 读取指定 id 的 mp4;不存在返回 null。 */
export async function readVideo(id: string): Promise<Buffer | null> {
  const safe = sanitizeVideoId(id);
  if (!safe) return null;
  try {
    return await fs.readFile(path.join(videoDir(), `${safe}.mp4`));
  } catch {
    return null;
  }
}
