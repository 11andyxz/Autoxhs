import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
} from "docx";

import type { TailoredResume } from "./schema";

/**
 * Word(.docx)导出,版式对齐用户偏好的经典模板(与 resumeHtml.ts 同款):
 * Times New Roman / US Letter / 0.5in 页边距;姓名+职位标题居中、下划线大写小标题、
 * 蓝色公司/职位行、Skills 双列带边框表格、Project Description / Responsibilities /
 * Environment 标签。
 */

const TNR = "Times New Roman";
const INK = "000000";
const BLUE = "4472C4"; // 公司/职位行配色,照搬参考模板

// US Letter(twips):8.5in x 11in,四周 0.5in 页边距。
const PAGE_WIDTH = 12240;
const PAGE_HEIGHT = 15840;
const PAGE_MARGIN = 720;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2; // 10800
const SKILL_CAT_WIDTH = Math.round(CONTENT_WIDTH * 0.27); // 左列(类别)
const SKILL_VAL_WIDTH = CONTENT_WIDTH - SKILL_CAT_WIDTH; // 右列(值)

const SKILL_RE = /skill|技能/i;
const EDU_RE = /education|教育|学历/i;

const CELL_MARGINS = { top: 20, bottom: 20, left: 100, right: 100 };
const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: INK } as const;
const TABLE_BORDERS = {
  top: CELL_BORDER,
  bottom: CELL_BORDER,
  left: CELL_BORDER,
  right: CELL_BORDER,
  insideHorizontal: CELL_BORDER,
  insideVertical: CELL_BORDER,
};

type Block = Paragraph | Table;

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 220, after: 80 },
    children: [
      new TextRun({
        text: text.toUpperCase(),
        bold: true,
        underline: { type: UnderlineType.SINGLE, color: INK },
        color: INK,
        font: TNR,
        size: 22,
      }),
    ],
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 30 },
    children: [new TextRun({ text, size: 22, color: INK, font: TNR })],
  });
}

function plainParagraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    children: [new TextRun({ text, size: 22, color: INK, font: TNR })],
  });
}

function labeledParagraph(label: string, body: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    children: [
      new TextRun({ text: label, bold: true, size: 22, color: INK, font: TNR }),
      new TextRun({ text: body, size: 22, color: INK, font: TNR }),
    ],
  });
}

function blueLine(text: string, after = 0): Paragraph {
  return new Paragraph({
    spacing: { after },
    children: [new TextRun({ text, bold: true, size: 22, color: BLUE, font: TNR })],
  });
}

function skillsTable(section: TailoredResume["sections"][number]): Block[] {
  const rows = section.items
    .map((it) => {
      const cat = it.title.trim();
      const valueParts = it.bullets.length ? it.bullets : it.subtitle ? [it.subtitle] : [];
      const values = valueParts.join(", ");
      if (!cat && !values) return null;
      return new TableRow({
        children: [
          new TableCell({
            width: { size: SKILL_CAT_WIDTH, type: WidthType.DXA },
            margins: CELL_MARGINS,
            children: [
              new Paragraph({
                children: [new TextRun({ text: cat, bold: true, size: 22, color: INK, font: TNR })],
              }),
            ],
          }),
          new TableCell({
            width: { size: SKILL_VAL_WIDTH, type: WidthType.DXA },
            margins: CELL_MARGINS,
            children: [
              new Paragraph({
                children: [new TextRun({ text: values, size: 22, color: INK, font: TNR })],
              }),
            ],
          }),
        ],
      });
    })
    .filter((r): r is TableRow => r !== null);

  if (!rows.length) return [];
  return [
    sectionHeading(section.heading),
    new Table({ width: { size: CONTENT_WIDTH, type: WidthType.DXA }, borders: TABLE_BORDERS, rows }),
  ];
}

function genericSection(section: TailoredResume["sections"][number]): Block[] {
  const out: Block[] = [];
  for (const it of section.items) {
    const left = [it.title, it.subtitle].filter(Boolean).join(" · ");
    const main = [left, it.dateRange].filter(Boolean).join(" — ");
    if (main) out.push(bullet(main));
    for (const b of it.bullets) out.push(bullet(b));
  }
  if (!out.length) return [];
  return [sectionHeading(section.heading), ...out];
}

export async function buildResumeDocx(resume: TailoredResume): Promise<Buffer> {
  const children: Block[] = [];

  if (resume.name) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: resume.headline ? 20 : 60 },
        children: [new TextRun({ text: resume.name, bold: true, size: 36, color: INK, font: TNR })],
      }),
    );
  }
  if (resume.headline) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [new TextRun({ text: resume.headline, bold: true, size: 22, color: INK, font: TNR })],
      }),
    );
  }
  for (const c of resume.contacts) {
    children.push(
      new Paragraph({
        spacing: { after: 0 },
        children: [new TextRun({ text: c, size: 20, color: INK, font: TNR })],
      }),
    );
  }

  if (resume.summary.length) {
    children.push(sectionHeading("Professional Summary"));
    for (const s of resume.summary) children.push(bullet(s));
  }

  const skillSections = resume.sections.filter((s) => SKILL_RE.test(s.heading));
  const eduSections = resume.sections.filter(
    (s) => !SKILL_RE.test(s.heading) && EDU_RE.test(s.heading),
  );
  const otherSections = resume.sections.filter(
    (s) => !SKILL_RE.test(s.heading) && !EDU_RE.test(s.heading),
  );

  for (const sec of skillSections) children.push(...skillsTable(sec));
  for (const sec of eduSections) children.push(...genericSection(sec));

  if (resume.experience.length) {
    children.push(sectionHeading("Professional Experience"));
    for (const e of resume.experience) {
      const companyLine = e.company
        ? `${e.company}${e.dates ? ` | ${e.dates}` : ""}`
        : e.dates;
      if (companyLine) children.push(blueLine(companyLine, e.role ? 0 : 20));
      if (e.role) children.push(blueLine(`Role: ${e.role}`, 40));

      const descParas = e.projectDescription
        .split(/\n\s*\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      descParas.forEach((p, i) => {
        if (i === 0) children.push(labeledParagraph("Project Description: ", p));
        else children.push(plainParagraph(p));
      });

      if (e.responsibilities.length) {
        children.push(
          new Paragraph({
            spacing: { after: 20 },
            children: [new TextRun({ text: "Responsibilities:", bold: true, size: 22, color: INK, font: TNR })],
          }),
        );
        for (const r of e.responsibilities) children.push(bullet(r));
      }

      if (e.environment) {
        children.push(labeledParagraph("Environment: ", e.environment));
      }

      // 经历之间留一行间距
      children.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
    }
  }

  for (const sec of otherSections) children.push(...genericSection(sec));

  const doc = new Document({
    styles: { default: { document: { run: { font: TNR } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: {
              top: PAGE_MARGIN,
              bottom: PAGE_MARGIN,
              left: PAGE_MARGIN,
              right: PAGE_MARGIN,
            },
          },
        },
        children:
          children.length > 0
            ? children
            : [new Paragraph({ children: [new TextRun({ text: "", size: 22 })] })],
      },
    ],
  });

  return Packer.toBuffer(doc);
}
