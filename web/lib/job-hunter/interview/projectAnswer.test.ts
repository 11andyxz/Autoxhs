import { describe, expect, it } from "vitest";

import {
  MAX_PREFERRED_PROJECT,
  MAX_PROJECT_ANSWER,
  MAX_QUESTION,
  MAX_RESUME_CHARS,
  cleanProjectAnswer,
  clipResumeForPrompt,
  hasUsableResume,
  normalizePreferredProject,
  projectAnswerInputs,
  resumeTextFromHtml,
  splitFencedBlocks,
} from "./projectAnswer";

/**
 * 「结合我的项目」的输入挑选与输出清洗。
 *
 * 这三步决定了模型看到什么、以及落库的是什么:简历取文丢掉结构 → 模型会把 A 项目的
 * 成果安到 B 项目上;输入判空放过空卡 → 模型无据可依只能编。所以边界都在这里钉住。
 */

describe("projectAnswerInputs", () => {
  it("问答卡:正面当题面,背面当原答案", () => {
    expect(projectAnswerInputs({ front: "  What is a checked exception?  ", content: " Throwable -- ... " })).toEqual({
      question: "What is a checked exception?",
      baseAnswer: "Throwable -- ...",
    });
  });

  it("没有正面的知识块:用正文开头当题面(不把整段正文再当一次题面)", () => {
    const content = "x".repeat(500);
    const r = projectAnswerInputs({ front: "", content })!;
    expect(r.question).toHaveLength(300);
    expect(r.baseAnswer).toBe(content);
  });

  it("正反面都空(含只有空白)→ null,不去问模型", () => {
    expect(projectAnswerInputs({ front: "", content: "" })).toBeNull();
    expect(projectAnswerInputs({ front: "   ", content: "\n\t " })).toBeNull();
    expect(projectAnswerInputs({ front: null, content: null })).toBeNull();
    expect(projectAnswerInputs({})).toBeNull();
  });

  it("超长题面按上限截断", () => {
    const r = projectAnswerInputs({ front: "q".repeat(MAX_QUESTION + 500), content: "a" })!;
    expect(r.question).toHaveLength(MAX_QUESTION);
  });
});

describe("resumeTextFromHtml", () => {
  it("去掉脚本/样式与标签,保留分段与项目符号", () => {
    const html = `<!doctype html><html><head><style>p{color:red}</style></head><body>
      <h2>Autoxhs Platform</h2>
      <p>Backend engineer<br>2023 - 2026</p>
      <ul><li>Cut p99 from 38ms to 22ms</li><li>Handled 5k QPS</li></ul>
      <script>steal()</script>
    </body></html>`;
    const t = resumeTextFromHtml(html);
    expect(t).toContain("Autoxhs Platform");
    expect(t).toContain("Backend engineer\n2023 - 2026");
    expect(t).toContain("• Cut p99 from 38ms to 22ms");
    expect(t).toContain("• Handled 5k QPS");
    expect(t).not.toContain("steal()");
    expect(t).not.toContain("color:red");
    expect(t).not.toMatch(/[<>]/);
  });

  it("解码常见实体、压掉多余空行、首尾去空", () => {
    const t = resumeTextFromHtml("<p>&nbsp;A&amp;B &quot;ok&quot; &#39;x&#39;</p><p></p><p></p><p></p><p>End</p>");
    expect(t).toBe('A&B "ok" \'x\'\n\nEnd');
  });

  it("段落之间不会粘成一行(模型据此分清哪条属于哪个项目)", () => {
    const t = resumeTextFromHtml("<div>Project A: search</div><div>Project B: billing</div>");
    expect(t.split("\n").map((s) => s.trim()).filter(Boolean)).toEqual(["Project A: search", "Project B: billing"]);
  });
});

describe("clipResumeForPrompt / hasUsableResume", () => {
  it("从开头截(简历在前,追加的复习资料在后)", () => {
    const text = "HEAD" + "x".repeat(MAX_RESUME_CHARS * 2);
    const clipped = clipResumeForPrompt(text);
    expect(clipped).toHaveLength(MAX_RESUME_CHARS);
    expect(clipped.startsWith("HEAD")).toBe(true);
  });

  it("空壳文档不算可用简历(免得模型无据可依只能编项目)", () => {
    expect(hasUsableResume("")).toBe(false);
    expect(hasUsableResume("   \n  ")).toBe(false);
    expect(hasUsableResume("我的简历")).toBe(false);
    expect(hasUsableResume("x".repeat(79))).toBe(false);
    expect(hasUsableResume("x".repeat(80))).toBe(true);
  });
});

describe("normalizePreferredProject", () => {
  it("压掉换行和多余空格(它会作为一条数据块喂给模型,别撑破提示词分块)", () => {
    expect(normalizePreferredProject(" Visa Token\n Service  (VTS) ")).toBe("Visa Token Service (VTS)");
  });

  it("空白 / 非字符串 → 空串(= 不指定,交给模型按题挑)", () => {
    expect(normalizePreferredProject("")).toBe("");
    expect(normalizePreferredProject("   \n ")).toBe("");
    expect(normalizePreferredProject(null)).toBe("");
    expect(normalizePreferredProject(undefined)).toBe("");
    expect(normalizePreferredProject(123)).toBe("");
    expect(normalizePreferredProject({ toString: () => "Visa" })).toBe("");
  });

  it("按列宽截断(preferred_project VARCHAR(120))", () => {
    expect(normalizePreferredProject("v".repeat(MAX_PREFERRED_PROJECT + 40))).toHaveLength(MAX_PREFERRED_PROJECT);
  });
});

describe("cleanProjectAnswer", () => {
  it("去掉整段的 ``` 围栏(带/不带语言标记)", () => {
    expect(cleanProjectAnswer("```\nIn my project we ...\n```")).toBe("In my project we ...");
    expect(cleanProjectAnswer("```text\nIn my project we ...\n```")).toBe("In my project we ...");
  });

  it("保留段落但压掉多余空行,首尾去空", () => {
    expect(cleanProjectAnswer("  A\n\n\n\nB  ")).toBe("A\n\nB");
    expect(cleanProjectAnswer("A\r\nB")).toBe("A\nB");
  });

  it("代码块以外的反引号不动", () => {
    expect(cleanProjectAnswer("we used `@ControllerAdvice` there")).toBe("we used `@ControllerAdvice` there");
  });

  it("空白输入 → 空串(路由据此判失败,不落库空答案)", () => {
    expect(cleanProjectAnswer("   \n ")).toBe("");
  });

  it("超长按入库上限截断", () => {
    expect(cleanProjectAnswer("y".repeat(MAX_PROJECT_ANSWER + 1000))).toHaveLength(MAX_PROJECT_ANSWER);
  });

  it("回答里带多个代码块时,别把首尾两个围栏当成「整段被包起来」剥掉", () => {
    const withCode = [
      "```java",
      "int a = 1;",
      "```",
      "中间这段是要说的话。",
      "```yaml",
      "ttl: 30s",
      "```",
    ].join("\n");
    const out = cleanProjectAnswer(withCode);
    expect(out).toBe(withCode); // 一个字都不能动
    expect(out).toContain("中间这段是要说的话。");
  });
});

describe("splitFencedBlocks", () => {
  it("散文/代码交替拆开,语言标记归一化成小写", () => {
    const text = "先说结论。\n\n```Java\nint a = 1;\n```\n\n这段代码说明 X。";
    expect(splitFencedBlocks(text)).toEqual([
      { kind: "text", lang: "", body: "先说结论。" },
      { kind: "code", lang: "java", body: "int a = 1;" },
      { kind: "text", lang: "", body: "这段代码说明 X。" },
    ]);
  });

  it("没有代码块 → 原样一段散文", () => {
    expect(splitFencedBlocks("就是一段话")).toEqual([{ kind: "text", lang: "", body: "就是一段话" }]);
  });

  it("多个代码块都能拆出来", () => {
    const b = splitFencedBlocks("a\n```java\nx\n```\nb\n```sql\nSELECT 1\n```\nc");
    expect(b.map((x) => x.kind)).toEqual(["text", "code", "text", "code", "text"]);
    expect(b[3]).toEqual({ kind: "code", lang: "sql", body: "SELECT 1" });
  });

  it("围栏没闭合(被 8000 字截断)也当代码块收尾,不吞掉内容", () => {
    const b = splitFencedBlocks("说明\n```java\nint a = 1;\nint b = 2;");
    expect(b).toEqual([
      { kind: "text", lang: "", body: "说明" },
      { kind: "code", lang: "java", body: "int a = 1;\nint b = 2;" },
    ]);
  });

  it("空串 → 空数组", () => {
    expect(splitFencedBlocks("")).toEqual([]);
  });
});
