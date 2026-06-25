import type { TailoredResume } from "@/lib/job-hunter/schema";

import type { SkillRow } from "./repo";

/** 把结构化简历压成纯文本,供出题/评分的 prompt 使用 */
export function resumeToText(resume: TailoredResume): string {
  const lines: string[] = [];
  if (resume.name) lines.push(resume.name);
  if (resume.headline) lines.push(resume.headline);
  if (resume.contacts.length) lines.push(resume.contacts.join(" | "));
  if (resume.summary.length) {
    lines.push("\nSummary:");
    for (const s of resume.summary) lines.push(`- ${s}`);
  }
  if (resume.experience.length) {
    lines.push("\nExperience:");
    for (const e of resume.experience) {
      lines.push(`${[e.role, e.company, e.dates].filter(Boolean).join(" | ")}`);
      if (e.projectDescription) lines.push(e.projectDescription);
      for (const r of e.responsibilities) lines.push(`- ${r}`);
      if (e.environment) lines.push(`Environment: ${e.environment}`);
    }
  }
  for (const sec of resume.sections) {
    lines.push(`\n${sec.heading}:`);
    for (const it of sec.items) {
      const head = [it.title, it.subtitle, it.dateRange].filter(Boolean).join(" | ");
      if (head) lines.push(head);
      for (const b of it.bullets) lines.push(`- ${b}`);
    }
  }
  return lines.join("\n").trim();
}

/** 把长文本切成带少量重叠的块(按段落聚合,控制在 ~chunkSize 字符) */
export function chunkText(text: string, chunkSize = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const para of paras) {
    if (cur && cur.length + para.length + 2 > chunkSize) {
      chunks.push(cur);
      cur = overlap > 0 ? cur.slice(Math.max(0, cur.length - overlap)) + "\n" + para : para;
    } else {
      cur = cur ? `${cur}\n\n${para}` : para;
    }
    // 单段就超长:硬切
    while (cur.length > chunkSize) {
      chunks.push(cur.slice(0, chunkSize));
      cur = cur.slice(chunkSize - overlap);
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.slice(0, 400); // 上限,防超大文档
}

/** 掌握度的滑动平均更新:首次取本次得分,之后 EWMA(α=0.5) */
export function nextMastery(oldMastery: number, attempts: number, score: number): number {
  if (attempts <= 0) return Math.round(score);
  return Math.round(oldMastery * 0.5 + score * 0.5);
}

/**
 * 自适应选题:优先弱(掌握度低)且重要的技能,未练过的额外加权;
 * 80% 走加权最优,20% 随机探索,避免总盯着同一个。
 */
export function selectNextSkill(skills: SkillRow[]): SkillRow | null {
  if (!skills.length) return null;
  const ranked = [...skills].sort((a, b) => priority(b) - priority(a));
  if (Math.random() < 0.2) {
    return skills[Math.floor(Math.random() * skills.length)];
  }
  return ranked[0];
}

function priority(s: SkillRow): number {
  const gap = 100 - s.mastery; // 越不会越优先
  const unpracticed = s.attempts === 0 ? 40 : 0; // 没练过的先练
  return gap * s.importance + unpracticed;
}
