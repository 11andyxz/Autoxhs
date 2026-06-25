import React from "react";

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";

import { ensureFontRegistered, PDF_FONT_FAMILY } from "./fonts";
import type { Analysis } from "./schema";

const COLORS = {
  ink: "#0f172a",
  body: "#1f2937",
  muted: "#64748b",
  line: "#e2e8f0",
  accent: "#0e7490",
};

const styles = StyleSheet.create({
  page: {
    fontFamily: PDF_FONT_FAMILY,
    fontSize: 10,
    lineHeight: 1.45,
    color: COLORS.body,
    paddingVertical: 40,
    paddingHorizontal: 44,
  },
  name: { fontSize: 22, fontWeight: "bold", color: COLORS.ink },
  contact: { fontSize: 9, color: COLORS.muted, marginTop: 4 },
  sectionHeading: {
    fontSize: 11,
    fontWeight: "bold",
    color: COLORS.accent,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
    paddingBottom: 3,
    marginBottom: 6,
  },
  section: { marginTop: 14 },
  bulletRow: { flexDirection: "row", marginTop: 2 },
  bulletDot: { width: 12, fontSize: 10 },
  bulletText: { flex: 1, fontSize: 10 },
  paragraph: { fontSize: 10.5, marginBottom: 10, color: COLORS.body },
  // analysis
  reportTitle: { fontSize: 18, fontWeight: "bold", color: COLORS.ink },
  reportSub: { fontSize: 9, color: COLORS.muted, marginTop: 4, marginBottom: 8 },
  scoreBox: {
    marginTop: 6,
    marginBottom: 4,
    flexDirection: "row",
    alignItems: "baseline",
  },
  scoreNum: { fontSize: 34, fontWeight: "bold", color: COLORS.accent },
  scoreOutOf: { fontSize: 12, color: COLORS.muted, marginLeft: 4 },
  chip: { fontSize: 10, color: COLORS.body, marginBottom: 2 },
  empty: { fontSize: 10, color: COLORS.muted },
});

function CoverLetterDocument({
  name,
  contact,
  paragraphs,
}: {
  name: string;
  contact: string;
  paragraphs: string[];
}) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={{ marginBottom: 16 }}>
          {!!name && <Text style={styles.name}>{name}</Text>}
          {!!contact && <Text style={styles.contact}>{contact}</Text>}
        </View>
        {paragraphs.map((p, i) => (
          <Text key={i} style={styles.paragraph}>
            {p}
          </Text>
        ))}
      </Page>
    </Document>
  );
}

function KeywordList({ items }: { items: string[] }) {
  if (!items.length) return <Text style={styles.empty}>（无）</Text>;
  return (
    <>
      {items.map((k, i) => (
        <Text key={i} style={styles.chip}>
          • {k}
        </Text>
      ))}
    </>
  );
}

function AnalysisDocument({
  analysis,
  candidateName,
  language,
}: {
  analysis: Analysis;
  candidateName: string;
  language: string;
}) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.reportTitle}>简历匹配分析报告</Text>
        <Text style={styles.reportSub}>
          {[candidateName ? `候选人：${candidateName}` : "", `生成语言：${language}`]
            .filter(Boolean)
            .join("    ")}
        </Text>

        <View style={styles.section}>
          <Text style={styles.sectionHeading}>匹配度评分</Text>
          <View style={styles.scoreBox}>
            <Text style={styles.scoreNum}>{analysis.matchScore}</Text>
            <Text style={styles.scoreOutOf}>/ 100</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeading}>已强化的 JD 关键词</Text>
          <KeywordList items={analysis.addedKeywords} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeading}>仍缺失 / 待补充的关键词</Text>
          <KeywordList items={analysis.missingKeywords} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeading}>本次改动摘要</Text>
          {analysis.changeSummary.length ? (
            analysis.changeSummary.map((c, i) => (
              <View key={i} style={styles.bulletRow}>
                <Text style={styles.bulletDot}>•</Text>
                <Text style={styles.bulletText}>{c}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.empty}>（无）</Text>
          )}
        </View>
      </Page>
    </Document>
  );
}

/** 把求职信字符串按空行拆成段落 */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+\n/g, "\n").trim())
    .filter(Boolean);
}

export async function renderCoverLetterPdf(
  coverLetter: string,
  name: string,
  contact: string,
): Promise<Buffer> {
  ensureFontRegistered();
  return Buffer.from(
    await renderToBuffer(
      <CoverLetterDocument
        name={name}
        contact={contact}
        paragraphs={splitParagraphs(coverLetter)}
      />,
    ),
  );
}

export async function renderAnalysisPdf(
  analysis: Analysis,
  candidateName: string,
  language: string,
): Promise<Buffer> {
  ensureFontRegistered();
  return Buffer.from(
    await renderToBuffer(
      <AnalysisDocument
        analysis={analysis}
        candidateName={candidateName}
        language={language}
      />,
    ),
  );
}
