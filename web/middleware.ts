import { NextResponse, type NextRequest } from "next/server";

/**
 * 公网部署用的「登录门 + 范围限定」。两者都由环境变量开启,本地不设 → 完全不生效,本机使用不受影响。
 *  - APP_PASSWORD:设了就启用全站密码门(未登录跳 /login)。
 *  - NEXT_PUBLIC_DEPLOY_MODE=public:只放行「面试/简历」相关路径,其余一律 404(fail-closed),
 *    确保雇员PII/财务/发邮件/小红书/Indeed 等不对公网暴露。
 */

const PUBLIC_MODE = process.env.NEXT_PUBLIC_DEPLOY_MODE === "public";
const PASSWORD = process.env.APP_PASSWORD || "";
const COOKIE = "axs_auth";

// 公开模式放行的路径前缀(白名单,fail-closed)。首页 "/" 单独判断。
const PUBLIC_ALLOW = ["/login", "/job-hunter", "/api/job-hunter", "/api/auth"];

function isAllowedPublicPath(path: string): boolean {
  if (path === "/") return true; // 首页(会按模式过滤工具卡)
  return PUBLIC_ALLOW.some((p) => path === p || path.startsWith(p + "/"));
}

async function expectedToken(): Promise<string> {
  const data = new TextEncoder().encode("axs:" + PASSWORD);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 公开模式:范围限定(白名单外一律 404)。
  if (PUBLIC_MODE && !isAllowedPublicPath(pathname)) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (PASSWORD) {
    // 登录页与登录/登出接口放行。
    if (pathname === "/login" || pathname.startsWith("/api/auth")) {
      return NextResponse.next();
    }
    const token = req.cookies.get(COOKIE)?.value;
    const ok = !!token && token === (await expectedToken());
    if (!ok) {
      if (pathname.startsWith("/api/")) {
        return new NextResponse(JSON.stringify({ success: false, error: "未登录" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  // 跑在页面/接口上,排除静态资源。
  matcher: ["/((?!_next/static|_next/image|favicon.ico|assets/).*)"],
};
