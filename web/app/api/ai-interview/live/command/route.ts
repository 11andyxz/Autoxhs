import { NextResponse, type NextRequest } from "next/server";

import {
  checkCode,
  enqueueLiveCommand,
  type LiveCommandType,
} from "@/lib/aiInterview/liveHub";
import { bad, rateLimited, tooManyIn } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手机上能按的动作;名字直接对应桌面端的 global-shortcut action。 */
/** 这条 body 只有 {k, type} 两个短字符串,几百字节足够。 */
const MAX_BODY_BYTES = 2_048;

const ALLOWED: readonly LiveCommandType[] = [
  "takeScreenshot",
  "processScreenshots",
  "resetCancel",
  "whatToAnswer",
];

/**
 * 副屏 → 桌面端的命令入口。
 *
 * 为什么需要:算法题时人盯着手机,而截图快捷键在 Mac 上 —— 看得见、按不到。
 * 手机点一下这里排一条,桌面端下一次推帧(150ms)的响应里取走执行。
 *
 * 这里只排队、不做事:真正的截图和送模型都在桌面端本机完成,这条请求不带任何
 * 图像数据,也不落库。
 */
export async function POST(req: NextRequest) {
  // 和推帧分开计数:手机连点几下不该把桌面端的推流挤掉。
  if (tooManyIn(req, "aiitv-command", 30)) return rateLimited();

  // 先看长度再解析。这条路由在公网隧道的白名单里,而 req.json() 会把整个 body
  // 读进内存 —— 一个没有配对码的调用方本来就该被拒,不该先让它把几百 MB 塞进来。
  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return bad("请求体过大。", 413);
  }

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return bad("请求体过大。", 413);
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return bad("请求格式有误。");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return bad("请求格式有误。");
  }

  // 配对码是这条通道唯一的门:没有它,同一局域网里任何人都能让你的 Mac 截屏。
  if (!checkCode(typeof body.k === "string" ? body.k : null)) {
    return bad("配对码不对。", 403);
  }

  // 自有属性 + 字符串,再查白名单。`{"__proto__": {...}}` 经 JSON.parse 是普通
  // 自有属性,但继承来的 type 不是服务端发的东西。
  const type = (Object.prototype.hasOwnProperty.call(body, "type") && typeof body.type === "string"
    ? body.type
    : "") as LiveCommandType;
  if (!ALLOWED.includes(type)) return bad("不支持这个动作。");

  const pending = enqueueLiveCommand(type);
  return NextResponse.json({ success: true, pending });
}
