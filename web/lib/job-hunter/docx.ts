import {
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
} from "docx";

import type { TailoredResume } from "./schema";

const INK = "0F172A";
const MUTED = "64748B";
const ACCENT = "0E7490";
// 页面几何(twips):A4 宽 11906,左右页边距各 1080。右对齐 tab 落在正文右边界,
// 否则日期不会贴右。
const A4_WIDTH = 11906;
const PAGE_MARGIN = 1080;
const RIGHT_TAB = A4_WIDTH - PAGE_MARGIN * 2; // 9746

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 220, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "E2E8F0", space: 1 } },
    children: [
      new TextRun({ text: text.toUpperCase(), bold: true, color: ACCENT, size: 22 }),
    ],
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 30 },
    children: [new TextRun({ text, size: 20, color: "1F2937" })],
  });
}

/** 公司/条目标题行:左侧加粗标题,右侧右对齐时间 */
function headingRow(left: string, right: string): Paragraph {
  const runs: TextRun[] = [];
  if (left) runs.push(new TextRun({ text: left, bold: true, size: 21, color: INK }));
  if (right) {
    runs.push(new TextRun({ text: "\t", size: 21 }));
    runs.push(new TextRun({ text: right, size: 18, color: MUTED }));
  }
  return new Paragraph({
    spacing: { before: 100, after: 20 },
    tabStops: right ? [{ type: TabStopType.RIGHT, position: RIGHT_TAB }] : undefined,
    children: runs,
  });
}

export async function buildResumeDocx(resume: TailoredResume): Promise<Buffer> {
  const children: Paragraph[] = [];

  if (resume.name) {
    children.push(
      new Paragraph({
        spacing: { after: resume.headline ? 20 : 40 },
        children: [new TextRun({ text: resume.name, bold: true, size: 44, color: INK })],
      }),
    );
  }
  if (resume.headline) {
    children.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [new TextRun({ text: resume.headline, bold: true, size: 22, color: ACCENT })],
      }),
    );
  }
  if (resume.contacts.length) {
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({ text: resume.contacts.join("  |  "), size: 18, color: MUTED }),
        ],
      }),
    );
  }

  if (resume.summary.length) {
    children.push(sectionHeading("Professional Summary"));
    for (const s of resume.summary) children.push(bullet(s));
  }

  if (resume.experience.length) {
    children.push(sectionHeading("Professional Experience"));
    for (const e of resume.experience) {
      if (e.company || e.dates) children.push(headingRow(e.company, e.dates));
      if (e.role) {
        children.push(
          new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({ text: e.role, bold: true, size: 20, color: ACCENT })],
          }),
        );
      }
      if (e.projectDescription) {
        for (const p of e.projectDescription.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)) {
          children.push(
            new Paragraph({
              spacing: { after: 40 },
              children: [new TextRun({ text: p, size: 20, color: "1F2937" })],
            }),
          );
        }
      }
      for (const r of e.responsibilities) children.push(bullet(r));
      if (e.environment) {
        children.push(
          new Paragraph({
            spacing: { before: 40, after: 60 },
            children: [
              new TextRun({ text: "Environment: ", bold: true, size: 18, color: "3F4B5D" }),
              new TextRun({ text: e.environment, size: 18, color: "3F4B5D" }),
            ],
          }),
        );
      }
    }
  }

  for (const section of resume.sections) {
    children.push(sectionHeading(section.heading));
    for (const item of section.items) {
      const left = [item.title, item.subtitle].filter(Boolean).join(" · ");
      if (left || item.dateRange) children.push(headingRow(left, item.dateRange));
      for (const b of item.bullets) children.push(bullet(b));
    }
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri" } } } },
    sections: [
      {
        properties: {
          page: {
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
            : [new Paragraph({ children: [new TextRun({ text: "", size: 20 })] })],
      },
    ],
  });

  return Packer.toBuffer(doc);
}
