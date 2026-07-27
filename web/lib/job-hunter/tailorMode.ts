/**
 * 「为 JD 定制」的三档内容尺度。两条链路(经典模板 generate / 保留原格式 tailorFormat)共用,
 * 保证同一次生成里简历正文与匹配分析用的是同一把尺子。
 *
 *  - strict     只重排、改写措辞,不动任何事实(最保守)。
 *  - adapt      **默认**。雇主 / 工作地点 / 起止时间 / 职位名一律不动,但工作内容可以按 JD 改写
 *               —— 必须**在原有内容的基础上**延展、换角度、换术语,不是凭空新增经历。
 *  - embellish  用户主动打开的激进匹配,允许编造以最大化匹配(风险自负)。
 */

export type TailorMode = "strict" | "adapt" | "embellish";

/** 激进优先;否则看「不激进匹配」是否开启(默认开)。 */
export function resolveTailorMode(allowEmbellish: boolean, adaptContent: boolean): TailorMode {
  if (allowEmbellish) return "embellish";
  return adaptContent ? "adapt" : "strict";
}

/** 表单里两个开关 → 模式。adaptContent 缺省视为开启(与前端默认一致)。 */
export function tailorModeFromForm(form: {
  get(name: string): FormDataEntryValue | null;
}): TailorMode {
  const raw = form.get("adaptContent");
  // 没传视为开启:这是默认档,老客户端/直接调接口的也走默认。
  const adaptContent = raw === null ? true : raw === "true";
  return resolveTailorMode(form.get("allowEmbellish") === "true", adaptContent);
}

/**
 * adapt 档的共用条款。两条链路的输出格式不同(JSON schema / HTML),
 * 但「什么能改、什么绝对不能改」这套政策必须一致,所以放在这里共用。
 */
export const ADAPT_POLICY = `Content adaptation (ON BY DEFAULT — this is the mode the user selected):
- NEVER change these, they are the candidate's verifiable record: employer / company names, work locations, employment dates (start and end), job titles, the candidate's name, contact lines, and education.
- WITHIN each of those fixed roles you SHOULD actively rewrite the WORK CONTENT for this JD: reframe responsibilities and achievements around the JD's problems, lead with the technologies, methods and domain language the JD asks for, merge or split bullets, and re-order them by relevance.
- Every rewritten bullet MUST BUILD ON something that is actually in that SAME role in the original resume — extend it, sharpen it, or express it in the JD's terms. Do not invent work the candidate never did, and never move an accomplishment from one employer to another.
- Do not invent new employers, roles, degrees, certifications, or headline metrics. If the JD needs something no role can honestly support, leave it out rather than inventing it.`;
