import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Autoxhs 工具箱",
  description: "Autoxhs 内部小工具集合。",
};

type Accent = "rose" | "emerald" | "cyan" | "violet" | "sky" | "amber" | "fuchsia" | "indigo" | "teal" | "orange" | "blue";

const ACCENTS: Record<Accent, { tile: string; hoverBorder: string; arrow: string }> = {
  rose: {
    tile: "bg-rose-50 text-rose-500",
    hoverBorder: "hover:border-rose-300",
    arrow: "text-rose-500",
  },
  emerald: {
    tile: "bg-emerald-50 text-emerald-600",
    hoverBorder: "hover:border-emerald-300",
    arrow: "text-emerald-600",
  },
  cyan: {
    tile: "bg-cyan-50 text-cyan-600",
    hoverBorder: "hover:border-cyan-300",
    arrow: "text-cyan-600",
  },
  violet: {
    tile: "bg-violet-50 text-violet-600",
    hoverBorder: "hover:border-violet-300",
    arrow: "text-violet-600",
  },
  sky: {
    tile: "bg-sky-50 text-sky-600",
    hoverBorder: "hover:border-sky-300",
    arrow: "text-sky-600",
  },
  amber: {
    tile: "bg-amber-50 text-amber-600",
    hoverBorder: "hover:border-amber-300",
    arrow: "text-amber-600",
  },
  fuchsia: {
    tile: "bg-fuchsia-50 text-fuchsia-600",
    hoverBorder: "hover:border-fuchsia-300",
    arrow: "text-fuchsia-600",
  },
  indigo: {
    tile: "bg-indigo-50 text-indigo-600",
    hoverBorder: "hover:border-indigo-300",
    arrow: "text-indigo-600",
  },
  teal: {
    tile: "bg-teal-50 text-teal-600",
    hoverBorder: "hover:border-teal-300",
    arrow: "text-teal-600",
  },
  orange: {
    tile: "bg-orange-50 text-orange-600",
    hoverBorder: "hover:border-orange-300",
    arrow: "text-orange-600",
  },
  blue: {
    tile: "bg-blue-50 text-blue-600",
    hoverBorder: "hover:border-blue-300",
    arrow: "text-blue-600",
  },
};

const TOOLS: Array<{
  href: string;
  name: string;
  en: string;
  desc: string;
  icon: string;
  accent: Accent;
}> = [
  {
    href: "/xiaohongshu",
    name: "小红书助手",
    en: "Xiaohongshu Assistant",
    desc: "文案发表 + 评论互动一站式:AI 帮你重写标题、优化正文、生成标签并一键发布;还能按关键词/推荐/链接选定笔记,AI 生成「正向且相关」的评论后批量互动、点赞。",
    icon: "✍️",
    accent: "rose",
  },
  {
    href: "/xhs-video",
    name: "笔记视频讲解",
    en: "Note Video Explainer",
    desc: "粘贴一条已发布的小红书笔记链接,AI 自动写讲解脚本、配音,为每个分镜生成配图并配上逐句同步字幕,拼成竖屏短视频。可预览、可下载,不自动发布。需本地 rednote 服务 + 本机 Chrome。",
    icon: "🎬",
    accent: "orange",
  },
  {
    href: "/service-fee",
    name: "收费计算器",
    en: "Service Fee Calculator",
    desc: "按真实日历计算工时、工资、Payroll Fee 与 Service Charge,并导出 Excel 明细。",
    icon: "🧮",
    accent: "emerald",
  },
  {
    href: "/job-hunter",
    name: "求职投递一条龙",
    en: "Tailor & Apply",
    desc: "上传简历 + 目标 JD,AI 定制简历、求职信与匹配分析;再带着这份定制简历直接一键投递 Indeed。投递需本地 Indeed 服务 + 已登录浏览器。",
    icon: "🎯",
    accent: "cyan",
  },
  {
    href: "/job-hunter/interview",
    name: "面试复习",
    en: "Interview Review",
    desc: "按遗忘曲线复习你的简历面试题库(按人名区分)与单词本:选一份题库作答、AI 打分并给讲解,每题自动排下次复习;划词可查音标/翻译/发音并加入单词本。题库在「求职投递一条龙」里生成,进度都存数据库。",
    icon: "🧠",
    accent: "fuchsia",
  },
  {
    href: "/ai-interview",
    name: "AI 辅助面试",
    en: "Live Interview Copilot",
    desc: "面试进行中的实时外挂:同时听「面试官的声音 + 你的麦克风」并转写,一检测到对方在提问,就按你的简历/JD 生成能直接照着说的答案(可要更细/换个说法/反问问题);算法题一键截屏读题给解法。全程本机运行,结束后自动复盘并可导出记录。",
    icon: "🎧",
    accent: "blue",
  },
  {
    href: "/employee",
    name: "雇员信息",
    en: "Employee Information",
    desc: "录入雇员基本信息,上传文件并按分类(如 i983)归档,Save 后存入数据库,可随时下载。",
    icon: "🪪",
    accent: "violet",
  },
  {
    href: "/business-expense",
    name: "Business 记账本",
    en: "Business Ledger",
    desc: "多 business 分账的收支记账本:记录收入/支出、归档发票凭证,自动汇总收支净额与按月/类别分布,可导出 Excel。",
    icon: "💰",
    accent: "sky",
  },
  {
    href: "/image-compress",
    name: "图片压缩",
    en: "Image Compressor",
    desc: "上传 JPG/PNG/WebP,设一个目标大小(MB),浏览器本地自动压到该大小或更小(先降画质、再按需缩尺寸),可看前后对比再下载。文件不上传。",
    icon: "🗜️",
    accent: "teal",
  },
  {
    href: "/pdf-tools",
    name: "PDF 工具箱",
    en: "PDF Toolbox",
    desc: "PDF 签名编辑:手绘/打字/上传做自己的签名,拖到合同任意位置(每页 Initials 也行);编辑 PDF 内容:点一下原文就能改字或删掉,还能加文字(支持中文)、涂白、高亮、插图片、删页/旋转/调页序;另有 PDF ⇄ Word 互转。签名与编辑全程浏览器本地合成导出。",
    icon: "🖋️",
    accent: "indigo",
  },
  {
    href: "/work-email",
    name: "工作邮件自动发送",
    en: "Work Email Auto-Send",
    desc: "上传上一封「周报工作计划」邮件,AI 顺着上周进度生成下一封;先预览、可修改,确认后从 adxztech Gmail 发给指定收件人(收件人来自雇员库)。",
    icon: "📧",
    accent: "amber",
  },
];

export default function Home() {
  // 公网部署模式:只展示「面试/简历」相关工具(其余路由在 middleware 里已 404)。
  const isPublic = process.env.NEXT_PUBLIC_DEPLOY_MODE === "public";
  const tools = isPublic ? TOOLS.filter((t) => t.href.startsWith("/job-hunter")) : TOOLS;
  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-4xl px-4 py-16 sm:py-20">
        {/* Hero */}
        <header className="mb-10">
          <span className="inline-flex items-center rounded-full bg-slate-900/5 px-3 py-1 text-xs font-medium text-slate-500">
            工具箱 · Toolbox
          </span>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Autoxhs
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-500">
            内部小工具集合。选择下面的工具开始使用。
          </p>
          <p className="mt-1 text-xs text-slate-400">共 {tools.length} 个工具</p>
        </header>

        {/* Tool cards */}
        <div className="grid gap-5 sm:grid-cols-2">
          {tools.map((tool) => {
            const a = ACCENTS[tool.accent];
            return (
              <Link
                key={tool.href}
                href={tool.href}
                className={`group flex flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition duration-200 hover:-translate-y-1 hover:shadow-md ${a.hoverBorder}`}
              >
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl text-2xl ${a.tile}`}>
                  <span aria-hidden>{tool.icon}</span>
                </div>
                <h2 className="mt-4 text-lg font-semibold text-slate-900">{tool.name}</h2>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{tool.en}</p>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-500">{tool.desc}</p>
                <span className={`mt-5 inline-flex items-center gap-1 text-sm font-semibold ${a.arrow}`}>
                  打开工具
                  <span className="transition-transform duration-200 group-hover:translate-x-1">→</span>
                </span>
              </Link>
            );
          })}
        </div>

        <footer className="mt-12 text-center text-xs text-slate-300">Autoxhs · 内部工具</footer>
      </div>
    </main>
  );
}
