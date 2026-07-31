import { NextResponse, type NextRequest } from "next/server";

import type { DesktopContext } from "@/lib/aiInterview/desktop";
import { getLatestContext } from "@/lib/aiInterview/repo";
import { readDefaultResume } from "@/lib/aiInterview/resumeSource";
import { fail, rateLimited, tooManyIn } from "@/lib/job-hunter/interview/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 桌面端(natively + Autoxhs 集成层)开一场面试前拉的上下文:默认简历 + 上一场的 JD/备忘/公司。
 *
 * 桌面端拿到之后自己缓存到本机(userData/autoxhs-profile.json),面试当下不再依赖网页在跑 ——
 * 网页没开、或者 Wi-Fi 断了,面试也不能停。所以这个接口只在「同步资料」时被调用一次。
 *
 * 简历不落库(PII,而且原件本来就在仓库里),这里只是解析成文本回给本机。
 */
export async function GET(req: NextRequest) {
  // 和转写/生成答案分桶:同步资料是低频请求,不该和实时那一路互相挤(见 http.ts 的注释)。
  if (tooManyIn(req, "aiitv-desktop", 60)) return rateLimited();

  try {
    // 上一场的 JD/备忘是「有就更好」:库连不上也不该让桌面端拿不到简历。
    const last = await getLatestContext().catch((err) => {
      console.warn("[ai-interview/desktop/context] 读上一场失败,只回简历", {
        code: (err as { code?: string } | null)?.code,
      });
      return null;
    });
    const resume = await readDefaultResume();

    const context: DesktopContext = {
      resume: resume?.text ?? "",
      resumeName: resume?.name ?? "",
      company: last?.company ?? "",
      jd: last?.jd ?? "",
      notes: last?.notes ?? "",
      mode: last?.mode ?? "tech",
      lang: last?.lang ?? "en",
      fromSessionId: last?.id ?? null,
    };

    return NextResponse.json({ success: true, context });
  } catch (err) {
    return fail(err, "ai-interview/desktop/context");
  }
}
