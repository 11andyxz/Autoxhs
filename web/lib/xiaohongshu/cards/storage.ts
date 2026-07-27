/**
 * 卡片叠(deck)的本地磁盘存储。
 * 落盘到 <uploadsRoot>/xhs-cards/<deckId>/{outline.json, 1.png, 2.png, ...}。
 *
 * 为什么落盘而不是留在内存/dataUrl：8~10 张 1440×1920 PNG base64 后几十 MB，
 * 塞进 React state 会卡页面、刷新即丢、也没法「只重画第 3 张」。
 *
 * uploads/ 全仓没有 TTL 清理，卡片堆积比视频快得多，所以这里自带 prune：
 * 每次新建 deck 时只保留最近 N 个（XHS_CARDS_KEEP_DECKS，默认 20）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { uploadsRoot } from "@/lib/employee/storage";

import type { CardOutline } from "./types";

const DEFAULT_KEEP_DECKS = 20;

function cardsRoot(): string {
  return path.join(uploadsRoot(), "xhs-cards");
}

/** 仅允许 [A-Za-z0-9_-]，杜绝路径穿越；不合法返回 null。 */
export function sanitizeDeckId(id: string): string | null {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

/** 生成一个随机、文件系统安全的 deck id。 */
export function newDeckId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${rand}`;
}

function deckDir(deckId: string): string {
  return path.join(cardsRoot(), deckId);
}

/** 卡片 PNG 的文件名用 1 起的序号，跟 UI 上「第几张」对齐。 */
function cardPath(deckId: string, index: number): string {
  return path.join(deckDir(deckId), `${index + 1}.png`);
}

/** 保存/覆盖单张卡片 PNG。 */
export async function saveCardPng(deckId: string, index: number, png: Buffer): Promise<void> {
  await fs.mkdir(deckDir(deckId), { recursive: true });
  await fs.writeFile(cardPath(deckId, index), png);
}

/** 读取单张卡片 PNG；不存在返回 null。 */
export async function readCardPng(deckId: string, index: number): Promise<Buffer | null> {
  const safe = sanitizeDeckId(deckId);
  if (!safe || !Number.isInteger(index) || index < 0) return null;
  try {
    return await fs.readFile(cardPath(safe, index));
  } catch {
    return null;
  }
}

/** 写入 outline（既是渲染输入，也是「这叠卡是什么」的唯一真相）。 */
export async function saveOutline(deckId: string, outline: CardOutline): Promise<void> {
  await fs.mkdir(deckDir(deckId), { recursive: true });
  await fs.writeFile(
    path.join(deckDir(deckId), "outline.json"),
    JSON.stringify(outline, null, 2),
    "utf-8",
  );
}

/** 读取 outline；不存在或损坏返回 null。 */
export async function readOutline(deckId: string): Promise<CardOutline | null> {
  const safe = sanitizeDeckId(deckId);
  if (!safe) return null;
  try {
    const raw = await fs.readFile(path.join(deckDir(safe), "outline.json"), "utf-8");
    return JSON.parse(raw) as CardOutline;
  } catch {
    return null;
  }
}

/**
 * 只保留最近 keep 个 deck 目录（按目录名前缀的时间戳排序，新的在前）。
 * 删除失败不抛错 —— 清理是尽力而为，不该拖垮生成流程。
 */
export async function pruneDecks(keep = deckKeepCount()): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(cardsRoot());
  } catch {
    return 0;
  }
  const decks = names.filter((n) => sanitizeDeckId(n) !== null).sort().reverse();
  const stale = decks.slice(Math.max(0, keep));
  let removed = 0;
  for (const name of stale) {
    try {
      await fs.rm(path.join(cardsRoot(), name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // 忽略：下次生成还会再试
    }
  }
  return removed;
}

function deckKeepCount(): number {
  const raw = Number(process.env.XHS_CARDS_KEEP_DECKS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_KEEP_DECKS;
}
