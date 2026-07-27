import { readFile } from "fs/promises";
import path from "path";

import { NextResponse } from "next/server";

/**
 * 「① 你的简历」的默认简历:页面一打开就预填这份,省得每次手动选文件(仍可随时换成别的)。
 *
 * 文件随仓库放在 web/assets/default-resume 下,**不放 public/** —— public 里的东西是裸露的静态
 * 资源,而这份简历带手机号/邮箱。走这个接口的话:公开部署模式下它落在 /api/job-hunter 白名单里,
 * 同时受 middleware 的 APP_PASSWORD 登录门保护(见 middleware.ts)。
 *
 * 部署到 Vercel 时,next.config.mjs 的 outputFileTracingIncludes 会把这个文件一起打包进函数。
 */

export const runtime = "nodejs";

const FILE_NAME = "Andy_Xiong_Senior_Backend_Java_Developer.docx";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function GET() {
  try {
    const buf = await readFile(
      path.join(process.cwd(), "assets", "default-resume", FILE_NAME),
    );
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": DOCX_MIME,
        "content-disposition": `inline; filename="${FILE_NAME}"`,
        // 内容随仓库发布,不会变;让浏览器缓存,避免每次进页面都重下。
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    // 没带上这个文件也不该让页面挂掉,前端拿到 404 就当没有默认简历。
    console.error("[job-hunter/default-resume] 默认简历文件缺失");
    return NextResponse.json({ success: false, error: "没有默认简历" }, { status: 404 });
  }
}
