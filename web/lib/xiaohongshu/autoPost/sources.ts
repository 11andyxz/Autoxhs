/**
 * 「来源」署名行的格式。
 *
 * 形如：`来源:USCIS -> Optional Practical Training Extension for STEM Students`
 *
 * 摆放位置**不在这里做** —— 署名要排进 caption 的「受保护尾部」（正文之后、CTA 之前），
 * 那件事只有 buildDesc 知道字数额度够不够，所以把这些行经 sourceLines 传给它。
 * 早先的做法是先拼到正文末尾，结果 caption 一超上限，署名就跟着正文一起被截掉。
 */

export type SourceRef = {
  /** 机构简称，如 USCIS / ICE SEVP / DHS / Federal Register */
  org: string;
  /** 官方页面标题，原样照抄，不要翻译 */
  title: string;
  /** 官方链接（不写进笔记，仅入库与核查用） */
  url?: string;
};

/** 一条来源署名行。 */
export function formatSourceLine(source: SourceRef): string {
  const org = source.org.trim().replace(/\s+/g, " ");
  const title = source.title.trim().replace(/\s+/g, " ");
  return `来源:${org} -> ${title}`;
}

/** 按 org+title 去重（忽略大小写），保持原顺序。 */
export function dedupeSources(sources: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const s of sources) {
    const org = (s?.org ?? "").trim();
    const title = (s?.title ?? "").trim();
    if (!org || !title) continue;
    const key = `${org}|${title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ org, title, url: s.url });
  }
  return out;
}

/** 取前 n 条去重后的来源，直接给 buildDesc 的 sourceLines 用。 */
export function buildSourceLines(sources: readonly SourceRef[], max = 3): string[] {
  return dedupeSources(sources)
    .slice(0, Math.max(1, max))
    .map(formatSourceLine);
}
