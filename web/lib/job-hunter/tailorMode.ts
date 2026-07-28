/**
 * 「为 JD 定制」的四档内容尺度,由弱到强。两条链路(经典模板 generate / 保留原格式 tailorFormat)
 * 共用,保证同一次生成里简历正文与匹配分析用的是同一把尺子。
 *
 *  - strict     只重排、改写措辞,不动任何事实(最保守)。
 *  - adapt      **默认**。雇主 / 工作地点 / 起止时间 / 职位名一律不动,工作内容可以按 JD 改写
 *               —— 但必须**在原有内容的基础上**延展、换角度、换术语,不凭空新增。
 *  - light      轻度激进。雇主 / 工作地点 / 起止时间照样锁死,但**允许在这些真实岗位内
 *               补充候选人其实没做过的职责、技术、成果**以匹配 JD;职位名默认也锁,
 *               可用子选项 allowRetitle 放开(见下)。
 *  - embellish  完全激进,连雇主 / 职位 / 学历都可能编造(风险自负)。
 *
 * 四档互斥,前端是单选。另外 light 档带一个子选项 `allowRetitle`:
 * 原简历写「Java Backend」而 JD 偏前端时,职位名硬扛着不改反而更假,所以允许把**职位名**
 * 往 JD 的方向挪一点 —— 但雇主/地点/日期照旧锁死,且不许借机升职或换成管理头衔。
 */

export const TAILOR_MODES = ["strict", "adapt", "light", "embellish"] as const;
export type TailorMode = (typeof TAILOR_MODES)[number];

export const DEFAULT_TAILOR_MODE: TailorMode = "adapt";

export function isTailorMode(v: unknown): v is TailorMode {
  return typeof v === "string" && (TAILOR_MODES as readonly string[]).includes(v);
}

/** 一次生成的完整尺度设定:档位 + 子选项。 */
export type TailorSpec = {
  mode: TailorMode;
  /** 只在 light 档有意义:允许把职位名往 JD 方向调整。 */
  allowRetitle: boolean;
};

/**
 * 表单 → 模式。优先读单选出来的 `tailorMode`;
 * 读不到再退回早期那两个布尔开关(老客户端 / 直接打接口的仍然能用)。
 */
export function tailorModeFromForm(form: {
  get(name: string): FormDataEntryValue | null;
}): TailorMode {
  const explicit = form.get("tailorMode");
  if (isTailorMode(explicit)) return explicit;

  if (form.get("allowEmbellish") === "true") return "embellish";
  const adapt = form.get("adaptContent");
  // 没传视为开启:adapt 是默认档。
  return adapt === null || adapt === "true" ? "adapt" : "strict";
}

/** 表单 → 完整设定。allowRetitle 只在 light 档生效,其它档一律按 false 处理。 */
export function tailorSpecFromForm(form: {
  get(name: string): FormDataEntryValue | null;
}): TailorSpec {
  const mode = tailorModeFromForm(form);
  return {
    mode,
    allowRetitle: mode === "light" && form.get("allowRetitle") === "true",
  };
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

/** 职位名锁死(默认)。 */
const TITLE_LOCKED = `- Job titles must stay EXACTLY as in the original resume — do not adjust them even if the JD implies a different discipline.`;

/**
 * 职位名可调。放开的是「往 JD 的方向挪」,不是「随便写」:
 * 原简历 Java Backend、JD 偏前端时,硬扛 Backend 反而更假,但也不能借机升职。
 */
const TITLE_ADJUSTABLE = `- Job titles MAY be adjusted so they don't contradict the JD's discipline (the user explicitly allowed this), but ONLY within these limits:
  * Same employer, same location, same dates — you are re-labelling the SAME job, not inventing a different one.
  * Same seniority. Never invent a promotion and never switch to a management/lead title the candidate did not hold (e.g. "Senior Software Engineer" must not become "Engineering Manager" or "Tech Lead").
  * The new title must be a conventional, believable title for that job at that employer.
  * Prefer the smallest change that removes the contradiction — e.g. "Senior Software Engineer, Backend" → "Senior Software Engineer, Full Stack" (or just "Senior Software Engineer"). Do not overshoot into a discipline the resume cannot support at all.
  * Keep the titles coherent as a career arc across roles, and make the work content of each role consistent with its new title.`;

/**
 * light 档的共用条款:硬约束照抄 adapt(雇主/地点/时间不动),
 * 但明确放开「可以补充没做过的工作内容」;职位名是否可动由 allowRetitle 决定。
 */
export function lightPolicy(allowRetitle: boolean): string {
  return `Content adaptation with light embellishment (EXPLICITLY SELECTED BY THE USER):
- STILL NEVER change these — they must match the original resume exactly: employer / company names, work locations, employment dates (start and end), the candidate's name, contact lines, and education.
${allowRetitle ? TITLE_ADJUSTABLE : TITLE_LOCKED}
- WITHIN those real roles you MAY ADD work the candidate did not actually do: extra responsibilities, technologies, engineering practices, and achievements (including plausible metrics) that this JD asks for. Put each addition in whichever existing role it fits most naturally.
- Keep every addition believable: plausible for that employer's actual business and scale, appropriate to the candidate's seniority at that time, consistent in time period, and coherent with the technologies already present elsewhere in the resume.
- Strengthen and reuse the candidate's REAL material first; invent only to cover what the JD needs and the resume genuinely lacks. Do not pad beyond the JD's requirements.
- Even here: no new employers, no new degrees or certifications, and no changes to dates or locations.`;
}
