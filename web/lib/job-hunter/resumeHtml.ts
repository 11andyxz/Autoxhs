import type { TailoredResume } from "./schema";

/**
 * 把结构化简历渲染成一份独立、自带样式的 HTML 文档。
 * 版式对齐用户偏好的经典 Word 模板(Times New Roman / US Letter / 0.5in 页边距):
 *   姓名 + 职位标题居中 → 联系方式左对齐 → 下划线大写小标题 →
 *   PROFESSIONAL SUMMARY(项目符号) → TECHNICAL SKILLS(双列表格) →
 *   EDUCATION(项目符号) → PROFESSIONAL EXPERIENCE(蓝色公司/职位行 +
 *   Project Description / Responsibilities / Environment) → 其它区块。
 * 同一份 HTML 既用于页面内 iframe 预览,也用于浏览器「打印另存为 PDF」。
 *
 * 安全:所有注入内容一律 HTML 转义,杜绝简历/模型内容注入标签或脚本
 * (例如简历里常见的 "IGNORE ALL PREVIOUS INSTRUCTIONS..." 之类文本只会作为纯文字出现)。
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 把多段文本(空行分隔)拆成 trim 后的非空段落数组 */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function bulletList(items: string[], className: string): string {
  if (!items.length) return "";
  const lis = items.map((b) => `<li>${esc(b)}</li>`).join("\n");
  return `<ul class="${className}">${lis}</ul>`;
}

function sectionTitle(text: string): string {
  return `<p class="section-title">${esc(text)}</p>`;
}

// 区块归类:Skills 走双列表格并排在 Experience 之前;Education 同样前置;
// 其余区块(Certifications / Projects 等)排在 Experience 之后。
const SKILL_RE = /skill|技能/i;
const EDU_RE = /education|教育|学历/i;

function experienceBlock(exp: TailoredResume["experience"]): string {
  if (!exp.length) return "";
  const items = exp
    .map((e) => {
      const company = e.company
        ? `<p class="exp-company">${esc(e.company)}${
            e.dates ? ` | ${esc(e.dates)}` : ""
          }</p>`
        : e.dates
          ? `<p class="exp-company">${esc(e.dates)}</p>`
          : "";
      const role = e.role ? `<p class="exp-role">Role: ${esc(e.role)}</p>` : "";

      const descParas = splitParagraphs(e.projectDescription);
      const desc = descParas.length
        ? descParas
            .map((p, i) =>
              i === 0
                ? `<p class="exp-para"><span class="exp-label">Project Description: </span>${esc(p)}</p>`
                : `<p class="exp-para">${esc(p)}</p>`,
            )
            .join("")
        : "";

      const resp = e.responsibilities.length
        ? `<p class="exp-para"><span class="exp-label">Responsibilities:</span></p>${bulletList(
            e.responsibilities,
            "responsibilities",
          )}`
        : "";
      const env = e.environment
        ? `<p class="exp-para"><span class="exp-label">Environment: </span>${esc(e.environment)}</p>`
        : "";

      return `<div class="exp-item">${company}${role}${desc}${resp}${env}</div>`;
    })
    .join("\n");
  return `${sectionTitle("Professional Experience")}${items}`;
}

/** Skills 区块:双列带边框表格(左列类别加粗 | 右列逗号分隔技能) */
function skillsTable(section: TailoredResume["sections"][number]): string {
  const rows = section.items
    .map((it) => {
      const cat = it.title;
      const valueParts = it.bullets.length ? it.bullets : it.subtitle ? [it.subtitle] : [];
      const values = valueParts.join(", ");
      if (!cat && !values) return "";
      return `<tr><td class="skills-cat">${esc(cat) || "&nbsp;"}</td><td>${
        esc(values) || "&nbsp;"
      }</td></tr>`;
    })
    .filter(Boolean)
    .join("\n");
  if (!rows) return "";
  return `${sectionTitle(section.heading)}<table class="skills-table"><tbody>${rows}</tbody></table>`;
}

/** 通用区块(Education / Certifications / Projects 等):项目符号列表 */
function genericSection(section: TailoredResume["sections"][number]): string {
  const lis: string[] = [];
  for (const it of section.items) {
    const left = [it.title, it.subtitle].filter(Boolean).map(esc).join(" &middot; ");
    const main = [left, it.dateRange ? esc(it.dateRange) : ""].filter(Boolean).join(" &mdash; ");
    if (main) lis.push(`<li>${main}</li>`);
    for (const b of it.bullets) lis.push(`<li>${esc(b)}</li>`);
  }
  if (!lis.length) return "";
  return `${sectionTitle(section.heading)}<ul class="generic-list">${lis.join("\n")}</ul>`;
}

export function buildResumeHtml(resume: TailoredResume): string {
  const skillSections = resume.sections.filter((s) => SKILL_RE.test(s.heading));
  const eduSections = resume.sections.filter(
    (s) => !SKILL_RE.test(s.heading) && EDU_RE.test(s.heading),
  );
  const otherSections = resume.sections.filter(
    (s) => !SKILL_RE.test(s.heading) && !EDU_RE.test(s.heading),
  );

  const contacts = resume.contacts
    .map((c) => `<p class="contact-line">${esc(c)}</p>`)
    .join("\n");

  const summary = resume.summary.length
    ? `${sectionTitle("Professional Summary")}${bulletList(resume.summary, "summary-list")}`
    : "";

  const title = esc(resume.name || "Resume");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Resume</title>
  <style>
    * { box-sizing: border-box; }
    html { background: #e9e9e9; }
    body {
      margin: 0;
      background: #e9e9e9;
      color: #000000;
      /* Times New Roman 为主,后接 CJK 衬线兜底,中文 JD 生成的中文简历不出现方块 */
      font-family: "Times New Roman", "Songti SC", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", serif;
      font-size: 11pt;
      line-height: 1.15;
      -webkit-font-smoothing: antialiased;
    }
    .page {
      width: 8.5in;
      min-height: 11in;
      margin: 24px auto;
      padding: 0.5in;
      background: #ffffff;
      box-shadow: 0 2px 14px rgba(0, 0, 0, 0.18);
      text-align: justify;
    }
    .name { text-align: center; font-size: 18pt; font-weight: bold; margin: 0; line-height: 1.1; }
    .title { text-align: center; font-size: 11pt; font-weight: bold; margin: 0 0 2pt; }
    .contact-line { font-size: 10pt; margin: 0; line-height: 1.25; text-align: left; }

    .section-title {
      font-size: 11pt;
      font-weight: bold;
      text-decoration: underline;
      text-transform: uppercase;
      text-align: left;
      margin: 12pt 0 5pt;
    }

    ul { margin: 0; padding-left: 0.3in; }
    li { font-size: 11pt; margin: 0 0 2pt; }
    .generic-list, .summary-list, .responsibilities { margin: 0 0 2pt; }

    .exp-item { margin: 0 0 9pt; }
    .exp-company { color: #4472c4; font-weight: bold; font-size: 11pt; margin: 0; text-align: left; }
    .exp-role { color: #4472c4; font-weight: bold; font-size: 11pt; margin: 0 0 2pt; text-align: left; }
    .exp-para { font-size: 11pt; margin: 0 0 4pt; }
    .exp-label { font-weight: bold; }

    .skills-table {
      border-collapse: collapse;
      width: 100%;
      table-layout: fixed;
      margin: 2pt 0 4pt;
    }
    .skills-table td {
      border: 1px solid #000000;
      padding: 2pt 6pt;
      font-size: 11pt;
      vertical-align: top;
      text-align: left;
      overflow-wrap: anywhere;
    }
    .skills-table .skills-cat { width: 27%; font-weight: bold; }

    @media screen and (max-width: 900px) {
      .page { width: calc(100% - 24px); min-height: auto; margin: 12px; padding: 24px; }
    }

    @media print {
      /* @page margin:0 让浏览器打印时不绘制默认页眉/页脚(日期、网址、页码);
         视觉页边距改由 .page 的 0.5in padding 实现。 */
      @page { size: Letter; margin: 0; }
      html, body { background: #ffffff; }
      .page { width: auto; min-height: 0; margin: 0; padding: 0.5in; box-shadow: none; }
      .exp-item { break-inside: avoid; }
      a { color: inherit !important; text-decoration: none !important; }
    }
  </style>
</head>
<body>
  <main class="page">
    <p class="name">${title}</p>
    ${resume.headline ? `<p class="title">${esc(resume.headline)}</p>` : ""}
    ${contacts}
    ${summary}
    ${skillSections.map(skillsTable).join("\n")}
    ${eduSections.map(genericSection).join("\n")}
    ${experienceBlock(resume.experience)}
    ${otherSections.map(genericSection).join("\n")}
  </main>
</body>
</html>`;
}
