/**
 * 「中文速读 + 英文照说」这种分层答案的解析(纯函数,可单测)。
 *
 * 模型按三个固定中文标签输出:
 *   速读:  中文逻辑骨架(术语保持英文),一眼扫完
 *   照着说:可以直接说出口的英文
 *   还可以补:一行关键词,提示你还能补哪些点
 *
 * 解析必须能吃**流式中途的半截文本**(最后一段还没写完是常态),
 * 而且模型偶尔不按格式时不能把页面搞空 —— 那种情况原样当纯文本显示。
 */

export type LayeredAnswer = {
  /** 中文速读(没有就空串) */
  gist: string;
  /** 英文照着说 */
  speak: string;
  /** 还可以补的点 */
  extra: string;
  /** 没识别出分层时的原文;有分层时为空串 */
  plain: string;
};

const LABELS = [
  { key: "gist" as const, re: /速读/ },
  { key: "speak" as const, re: /照着说/ },
  { key: "extra" as const, re: /还可以补/ },
];

/**
 * 一行标签:允许 【】、**、前导空格,冒号全角半角都行。
 * 两个细节:①用 m 标志让 ^ 匹配每行开头(正文里出现「速读」二字不会被当标签);
 * ②冒号后只吃空格/制表符,**不能吃换行** —— 吃掉换行会把下一行的标签行首吞掉,
 * 后面的标签就匹配不上了(踩过:三段变成两段、正文串位)。
 */
const LABEL_LINE = /^[ \t]*[【\*"']*\s*(速读|照着说|还可以补)\s*[】\*"']*\s*[:：][ \t]*/gm;

export function splitLayered(text: string): LayeredAnswer {
  const out: LayeredAnswer = { gist: "", speak: "", extra: "", plain: "" };
  if (!text.trim()) return out;

  const hits: Array<{ key: "gist" | "speak" | "extra"; from: number; to: number }> = [];
  LABEL_LINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_LINE.exec(text)) !== null) {
    const label = LABELS.find((l) => l.re.test(m![1]));
    if (label) hits.push({ key: label.key, from: m.index, to: m.index + m[0].length });
  }
  if (!hits.length) {
    out.plain = text.trim();
    return out;
  }

  hits.forEach((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].from : text.length;
    const body = text.slice(hit.to, end).trim();
    // 同一个标签重复出现时(模型偶发),后面的接在前面后面,不覆盖
    out[hit.key] = out[hit.key] ? `${out[hit.key]} ${body}`.trim() : body;
  });

  // 只出现了标签、正文全空 → 当没分层处理,别显示三个空框
  if (!out.gist && !out.speak && !out.extra) {
    out.plain = text.trim();
  }
  return out;
}
