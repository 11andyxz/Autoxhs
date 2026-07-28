/**
 * 联网查证：先查官方最新口径，再拿查到的东西回头校一遍写好的正文。
 *
 * 两次调用都开 OpenAI 的 `web_search` 工具 —— 移民规则会变（费用、时长、表格版本、政策公告），
 * 模型脑子里的旧知识不能直接往外发。所有事实必须落在官方来源上：
 * uscis.gov / ice.gov(SEVP) / studyinthestates.dhs.gov / dhs.gov / travel.state.gov /
 * federalregister.gov。查不到官方出处的说法，宁可不写。
 */

import { getClient, getModel } from "@/lib/openai";

import type { SourceRef } from "./sources";

// 实测：一次带 web_search 的查证要 2.5~4 分钟（模型会连着开十几个官方页），
// 复核那一步也差不多。给足余量，别让「查得认真」变成超时失败。
const RESEARCH_TIMEOUT_MS = 420_000;
const VERIFY_TIMEOUT_MS = 360_000;

/** 官方域名白名单：来源只认这些，其它一律不算「官方」。 */
export const OFFICIAL_HOSTS = [
  "uscis.gov",
  "ice.gov",
  "studyinthestates.dhs.gov",
  "dhs.gov",
  "travel.state.gov",
  "state.gov",
  "federalregister.gov",
  "dol.gov",
  "ssa.gov",
  "irs.gov",
];

export type ResearchResult = {
  /** 查证时间（模型自报的资料时效，如 "2026-07"） */
  asOf: string;
  /** 可直接写进笔记的事实要点 */
  facts: string[];
  /** 容易被误解、值得提醒的点 */
  cautions: string[];
  /** 官方来源（署名用） */
  sources: SourceRef[];
};

export type VerifyResult = {
  /** 校对后的正文（结构与原文保持一致） */
  body: string;
  /** 改了什么 / 删了什么（日志用） */
  issues: string[];
};

/** 从模型输出里抠出 JSON（可能带 ```json 围栏或前后废话）。 */
function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : t;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("模型输出不是合法 JSON");
  }
}

function isOfficial(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OFFICIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function toSources(raw: unknown): SourceRef[] {
  if (!Array.isArray(raw)) return [];
  const out: SourceRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as { org?: unknown; title?: unknown; url?: unknown };
    const org = typeof r.org === "string" ? r.org.trim() : "";
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (!org || !title) continue;
    // 非官方域名的来源直接丢掉：署名写着「来源:USCIS」结果指向某个中介博客，比不写还糟
    if (url && !isOfficial(url)) continue;
    out.push({ org, title, url: url || undefined });
  }
  return out;
}

function toStrings(raw: unknown, max = 12): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** 用 web_search 跑一次调用并返回文本（strict json_schema 与工具混用时偶有拒绝，故只要求「输出 JSON」）。 */
async function searchAndAnswer(prompt: string, timeoutMs: number): Promise<string> {
  const client = getClient(timeoutMs, 0);
  const response = await client.responses.create({
    model: getModel(),
    input: [{ role: "user", content: prompt }],
    // SDK 4.104 的类型里还只有 web_search_preview；实测 web_search 可用（见 docs 注释）
    tools: [{ type: "web_search" } as never],
  } as never);
  const text = (response as { output_text?: string }).output_text ?? "";
  if (!text.trim()) throw new Error("联网查证返回为空");
  return text;
}

/**
 * 第一步：就这个主题去官网查最新口径，产出「事实要点 + 官方来源」。
 * 只给事实，不写文案 —— 文案由后面的改写模型基于这些事实来写。
 */
export async function researchTopic(topic: string, theme: string): Promise<ResearchResult> {
  const prompt = `你是移民与留学身份规则的事实核查员。请**联网搜索**，就下面这个主题查清美国官方最新口径。

主题：${topic}
背景领域：${theme}

要求：
1. 必须以官方来源为准，优先 USCIS(uscis.gov)、ICE SEVP(ice.gov)、Study in the States(studyinthestates.dhs.gov)、DHS、美国务院(travel.state.gov)、Federal Register。不要引用中介、论坛、自媒体。
2. 逐条核对数字与时间（天数上限、申请窗口、有效期、费用、表格编号与版本、生效日期）。如果最近有规则变化或新公告，必须指出「什么时候变的、现在是什么」。
3. 拿不准或官方没有明确写的，放进 cautions 说明「官方未明确 / 个案差异」，**不要编**。
4. facts 用中文写，每条一句话、自带具体数字或条件，能直接作为写作素材。
5. sources 只列真正支撑上述事实的官方页面，title 用页面的英文原标题（不要翻译），org 用机构简称（如 USCIS、ICE SEVP、DHS、U.S. Department of State）。

只输出 JSON，不要解释：
{"asOf":"YYYY-MM","facts":["..."],"cautions":["..."],"sources":[{"org":"USCIS","title":"...","url":"https://..."}]}`;

  const json = parseJsonLoose(await searchAndAnswer(prompt, RESEARCH_TIMEOUT_MS)) as {
    asOf?: unknown;
    facts?: unknown;
    cautions?: unknown;
    sources?: unknown;
  };

  const facts = toStrings(json.facts);
  const sources = toSources(json.sources);
  if (facts.length === 0) throw new Error("联网查证没拿到任何事实要点");
  if (sources.length === 0) throw new Error("联网查证没拿到官方来源（不发无出处的内容）");

  return {
    asOf: typeof json.asOf === "string" ? json.asOf : "",
    facts,
    cautions: toStrings(json.cautions, 8),
    sources,
  };
}

/**
 * 第二步：拿写好的正文再过一遍 —— 联网复核每一处事实，错的就地改对，
 * 没有官方依据的就删掉。结构、语气、排版保持原样。
 *
 * 这一步只管「对不对」，不管「好不好看」：明确禁止它顺手重写文风或改动 CTA。
 */
export async function verifyBody(
  body: string,
  research: ResearchResult,
  ctaLine: string,
): Promise<VerifyResult> {
  const prompt = `你是事实核查编辑。下面是一篇即将发布到小红书的中文笔记正文，主题与美国留学生身份规则有关。
请**联网核对**其中所有事实性表述（天数、期限、时间窗口、费用、表格编号、政策变化），以官方来源为准
（uscis.gov / ice.gov / studyinthestates.dhs.gov / dhs.gov / travel.state.gov / federalregister.gov）。

处理规则：
1. 事实错误 → 就地改成正确表述；不确定或官方没写 → 改成保守说法或整句删掉，不要保留可能误导的内容。
2. **不要**改写文风、不要重排段落、不要增删表情符号、不要动排版，只动出错的地方。
3. 最后一句固定引导语必须原样保留在最后：「${ctaLine}」。不要新增任何其它引导语。
4. 已有的「来源:」行如果还在正文里，保持原样。
5. 保持中文，保持字数大致不变。

已核实的事实要点（供参考，仍需你自己联网复核）：
${research.facts.map((f) => `- ${f}`).join("\n")}

正文如下（三个反引号之间）：
\`\`\`
${body}
\`\`\`

只输出 JSON，不要解释：
{"body":"校对后的完整正文","issues":["改了什么，一条一句；没有就空数组"]}`;

  const json = parseJsonLoose(await searchAndAnswer(prompt, VERIFY_TIMEOUT_MS)) as {
    body?: unknown;
    issues?: unknown;
  };

  const next = typeof json.body === "string" ? json.body.trim() : "";
  // 校对后的正文明显变短（少于原文一半）= 模型跑偏了，宁可用原文，不要发个残篇
  if (!next || next.length < body.length * 0.5) {
    return { body, issues: ["校对结果异常（为空或大幅缩水），已保留原文"] };
  }
  return { body: next, issues: toStrings(json.issues, 10) };
}
