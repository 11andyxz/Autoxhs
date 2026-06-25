import type { TailoredResume } from "./schema";

/**
 * 把结构化简历渲染成一份独立、自带样式的 HTML 文档(用户偏好的单页 Letter 模板)。
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

function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function bulletList(items: string[], className: string): string {
  if (!items.length) return "";
  const lis = items.map((b) => `<li>${esc(b)}</li>`).join("\n");
  return `<ul class="${className}">${lis}</ul>`;
}

function experienceBlock(exp: TailoredResume["experience"]): string {
  if (!exp.length) return "";
  const items = exp
    .map((e) => {
      const heading = `<div class="experience-heading"><h3>${esc(e.company) || "&nbsp;"}</h3>${
        e.dates ? `<div class="dates">${esc(e.dates)}</div>` : ""
      }</div>`;
      const role = e.role ? `<div class="role">${esc(e.role)}</div>` : "";
      const desc = e.projectDescription
        ? `<div class="project-description">${paragraphs(e.projectDescription)}</div>`
        : "";
      const resp = e.responsibilities.length
        ? `<h4>Responsibilities</h4>${bulletList(e.responsibilities, "responsibilities")}`
        : "";
      const env = e.environment
        ? `<p class="environment"><strong>Environment:</strong> ${esc(e.environment)}</p>`
        : "";
      return `<article class="experience-item">${heading}${role}${desc}${resp}${env}</article>`;
    })
    .join("\n");
  return `<section aria-labelledby="experience-heading"><h2 id="experience-heading">Professional Experience</h2>${items}</section>`;
}

function genericSections(sections: TailoredResume["sections"]): string {
  return sections
    .map((sec) => {
      const items = sec.items
        .map((it) => {
          const left = [it.title, it.subtitle].filter(Boolean).map(esc).join(" · ");
          const right = it.dateRange ? esc(it.dateRange) : "";
          const head =
            left || right
              ? `<div class="experience-heading"><h3>${left || "&nbsp;"}</h3>${
                  right ? `<div class="dates">${right}</div>` : ""
                }</div>`
              : "";
          const bullets = bulletList(it.bullets, "responsibilities");
          return `<article class="experience-item">${head}${bullets}</article>`;
        })
        .join("\n");
      return `<section><h2>${esc(sec.heading)}</h2>${items}</section>`;
    })
    .join("\n");
}

export function buildResumeHtml(resume: TailoredResume): string {
  const contacts = resume.contacts
    .map((c) => `<span>${esc(c)}</span>`)
    .join("\n");

  const summary = resume.summary.length
    ? `<section aria-labelledby="summary-heading"><h2 id="summary-heading">Professional Summary</h2>${bulletList(
        resume.summary,
        "summary-list",
      )}</section>`
    : "";

  const title = esc(resume.name || "Resume");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Resume</title>
  <style>
    :root {
      --ink: #172033;
      --muted: #5d6778;
      --accent: #2457a6;
      --line: #d9e0ea;
      --paper: #ffffff;
      --background: #eef2f7;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--background);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      font-size: 15px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    .resume {
      width: min(980px, calc(100% - 32px));
      margin: 32px auto;
      padding: 48px 56px;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 18px 50px rgba(28, 42, 66, 0.10);
    }
    header { padding-bottom: 24px; border-bottom: 2px solid var(--accent); }
    h1 { margin: 0; font-size: clamp(34px, 5vw, 48px); line-height: 1.05; letter-spacing: -0.035em; }
    .headline { margin-top: 10px; color: var(--accent); font-size: 18px; font-weight: 700; }
    .contact { display: flex; flex-wrap: wrap; gap: 7px 18px; margin-top: 16px; color: var(--muted); font-size: 14px; }
    section { margin-top: 30px; }
    h2 { margin: 0 0 14px; color: var(--accent); font-size: 17px; line-height: 1.2; letter-spacing: 0.12em; text-transform: uppercase; }
    .summary-list, .responsibilities { margin: 0; padding-left: 20px; }
    li { margin: 5px 0; }
    li::marker { color: var(--accent); }
    .experience-item { padding: 23px 0 25px; border-top: 1px solid var(--line); break-inside: auto; }
    .experience-item:first-of-type { padding-top: 4px; border-top: 0; }
    .experience-heading { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: baseline; }
    h3 { margin: 0; font-size: 20px; line-height: 1.25; }
    .dates { color: var(--muted); font-size: 14px; font-weight: 650; white-space: nowrap; }
    .role { margin: 4px 0 12px; color: var(--accent); font-weight: 750; }
    .project-description p { margin: 8px 0; }
    h4 { margin: 16px 0 5px; font-size: 15px; }
    .environment { margin: 15px 0 0; padding: 11px 13px; background: #f5f7fb; border-left: 3px solid var(--accent); color: #3f4b5d; font-size: 13px; line-height: 1.5; }
    @media (max-width: 700px) {
      .resume { width: 100%; margin: 0; padding: 30px 22px; border: 0; border-radius: 0; box-shadow: none; }
      .experience-heading { grid-template-columns: 1fr; gap: 2px; }
      .dates { white-space: normal; }
      body { background: var(--paper); }
    }
    @media print {
      /* margin:0 让浏览器打印时不再绘制默认的页眉/页脚(日期、网址、页码);
         视觉页边距改由 .resume 的 padding 实现。 */
      @page { size: Letter; margin: 0; }
      body { background: #fff; font-size: 10pt; line-height: 1.42; }
      .resume { width: auto; margin: 0; padding: 0.5in 0.55in; border: 0; border-radius: 0; box-shadow: none; }
      header { padding-bottom: 12pt; }
      h1 { font-size: 27pt; }
      .headline { font-size: 12pt; margin-top: 4pt; }
      .contact { margin-top: 8pt; font-size: 9pt; gap: 2pt 12pt; }
      section { margin-top: 17pt; }
      h2 { margin-bottom: 8pt; font-size: 11pt; }
      h3 { font-size: 12pt; }
      .dates { font-size: 9pt; }
      .role { margin: 2pt 0 7pt; }
      li { margin: 2pt 0; }
      .experience-item { padding: 11pt 0 12pt; }
      .environment { font-size: 8.5pt; padding: 6pt 8pt; margin-top: 8pt; }
      a { color: inherit !important; text-decoration: none !important; }
    }
  </style>
</head>
<body>
  <main class="resume">
    <header>
      <h1>${title}</h1>
      ${resume.headline ? `<div class="headline">${esc(resume.headline)}</div>` : ""}
      ${contacts ? `<div class="contact" aria-label="Contact information">${contacts}</div>` : ""}
    </header>
    ${summary}
    ${experienceBlock(resume.experience)}
    ${genericSections(resume.sections)}
  </main>
</body>
</html>`;
}
