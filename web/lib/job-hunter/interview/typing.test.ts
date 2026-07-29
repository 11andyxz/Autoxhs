import { describe, expect, it } from "vitest";

import {
  applyInput,
  applyInputIde,
  applyKey,
  calcAccuracy,
  calcWpm,
  codeSegments,
  findSnippet,
  dropClosedFrom,
  durationLabel,
  indentSkip,
  lineCount,
  matchCloser,
  normalizeCode,
  suggestGrade,
  tabSkip,
} from "./typing";

describe("normalizeCode", () => {
  it("统一换行、展开 Tab、去行尾空白与首尾空行", () => {
    const src = "\r\n\tfoo();  \r\n\t\tbar();\n\n";
    expect(normalizeCode(src)).toBe("    foo();\n        bar();");
  });

  it("剥掉模型可能带上的代码围栏", () => {
    expect(normalizeCode("```java\nint a = 1;\n```")).toBe("int a = 1;");
  });

  it("把敲不出来的中文标点换回 ASCII", () => {
    expect(normalizeCode("s.equals(“a”) && t.equals(‘b’)")).toBe("s.equals(\"a\") && t.equals('b')");
  });

  it("不间断空格换成普通空格", () => {
    expect(normalizeCode("a =　1;")).toBe("a = 1;");
  });
});

describe("indentSkip", () => {
  const target = "if (x) {\n    doIt();\n}";
  it("返回换行后下一行的缩进空格数", () => {
    expect(indentSkip(target, target.indexOf("\n"))).toBe(4);
  });
  it("下一行没有缩进时返回 0", () => {
    expect(indentSkip(target, target.lastIndexOf("\n"))).toBe(0);
  });
});

describe("applyKey", () => {
  const target = "if (x) {\n    doIt();\n}";

  it("敲对了就落字", () => {
    expect(applyKey(target, 0, "i")).toEqual({ accept: "i", error: false });
  });

  it("敲错了不落字、记一次错", () => {
    expect(applyKey(target, 0, "x")).toEqual({ accept: "", error: true });
  });

  it("回车顺带补齐下一行缩进", () => {
    const nl = target.indexOf("\n");
    expect(applyKey(target, nl, "\n")).toEqual({ accept: "\n    ", error: false });
  });

  it("缩进位置多敲的空格直接忽略,不算错", () => {
    const i = target.indexOf("doIt");
    expect(applyKey(target, i, " ")).toEqual({ accept: "", error: false });
  });

  it("非缩进位置敲空格仍然算错", () => {
    const i = target.indexOf("(");
    expect(applyKey(target, i, " ")).toEqual({ accept: "", error: true });
  });

  it("已敲完后再按键不产生任何变化", () => {
    expect(applyKey(target, target.length, "x")).toEqual({ accept: "", error: false });
  });
});

describe("applyInput", () => {
  const target = "SELECT 1;";
  it("一次多个字符全对时全部落字", () => {
    expect(applyInput(target, 0, "SEL")).toEqual({ accept: "SEL", consumed: 3, error: false });
  });
  it("遇到第一个错就停,保证已敲内容始终是前缀", () => {
    const out = applyInput(target, 0, "SEx");
    expect(out).toEqual({ accept: "SE", consumed: 2, error: true });
    expect(target.startsWith(out.accept)).toBe(true);
  });
  it("回车只算一次按键,自动补的缩进不算", () => {
    const code = "if (x) {\n    doIt();";
    const out = applyInput(code, code.indexOf("\n"), "\n");
    expect(out).toEqual({ accept: "\n    ", consumed: 1, error: false });
  });
});

describe("tabSkip", () => {
  it("补完当前位置的连续空格", () => {
    const target = "a\n    b";
    expect(tabSkip(target, 2)).toBe("    ");
  });
  it("当前不是空格时什么也不补", () => {
    expect(tabSkip("abc", 0)).toBe("");
  });
});

describe("matchCloser", () => {
  it("泛型尖括号按深度配对", () => {
    const code = "Map<String, List<String>> m;";
    expect(matchCloser(code, code.indexOf("<"))).toBe(code.lastIndexOf(">"));
    expect(matchCloser(code, code.indexOf("List<") + 4)).toBe(code.indexOf(">>"));
  });

  it("小于号没有配对的 > 就不当括号", () => {
    expect(matchCloser("if (a < b) {", 7)).toBe(-1);
  });

  it("尖括号不跨行(下一行的 > 不算配对)", () => {
    expect(matchCloser("a < b\nc > d", 2)).toBe(-1);
  });

  it("圆括号可以跨行配对", () => {
    const code = "foo(\n    bar()\n);";
    expect(matchCloser(code, 3)).toBe(code.lastIndexOf(")"));
  });

  it("引号找同一行下一个未转义的同款引号", () => {
    const code = 'say("hi \\" there");';
    expect(matchCloser(code, 4)).toBe(code.lastIndexOf('"'));
  });

  it("不是开括号返回 -1", () => {
    expect(matchCloser("abc", 1)).toBe(-1);
  });
});

describe("applyInputIde", () => {
  it("敲开括号后,配对的闭括号不用再敲(走到那儿自动跳过)", () => {
    const code = "toList()";
    const closed = new Set<number>();
    // 敲到 "toList(" 为止
    const a = applyInputIde(code, 0, "toList(", closed);
    // "(" 的配对 ")" 紧跟其后 → 直接补上,已敲内容变成整行
    expect(a.accept).toBe("toList()");
    expect(a.auto).toBe(")");
    expect(a.consumed).toBe(7); // 自动补的那下不算按键
    expect(code.startsWith(a.accept)).toBe(true);
  });

  it("泛型:敲 Map< 就把最外层的 > 记下,填完内容自动收尾", () => {
    const code = "Map<String> m";
    const closed = new Set<number>();
    const a = applyInputIde(code, 0, "Map<", closed);
    expect(a.accept).toBe("Map<");
    expect(closed.has(code.indexOf(">"))).toBe(true);
    const b = applyInputIde(code, a.accept.length, "String", closed);
    expect(a.accept + b.accept).toBe("Map<String>"); // > 自动补上
    expect(b.auto).toBe(">");
  });

  it("习惯性又把闭括号敲了一遍 → 静默忽略,不算错", () => {
    const code = "f()";
    const closed = new Set<number>();
    const a = applyInputIde(code, 0, "f(", closed);
    expect(a.accept).toBe("f()");
    const b = applyInputIde(code, a.accept.length, ")", closed);
    expect(b.error).toBe(false);
    expect(b.accept).toBe("");
    expect(b.consumed).toBe(1);
  });

  it("连续多个闭括号一次跳完", () => {
    const code = "a(b(c))";
    const closed = new Set<number>();
    let typed = "";
    for (const ch of "a(b(c") {
      const out = applyInputIde(code, typed.length, ch, closed);
      typed += out.accept;
    }
    expect(typed).toBe("a(b(c))");
  });

  it("敲错照样算错,且已敲内容仍是前缀", () => {
    const code = "foo();";
    const closed = new Set<number>();
    const out = applyInputIde(code, 0, "fx", closed);
    expect(out.error).toBe(true);
    expect(out.accept).toBe("f");
    expect(code.startsWith(out.accept)).toBe(true);
  });

  it("退格后自动补标记作废,重敲开括号会重新补", () => {
    const code = "f()";
    const closed = new Set<number>();
    applyInputIde(code, 0, "f(", closed);
    expect(closed.size).toBe(1);
    dropClosedFrom(closed, 1); // 退回到只剩 "f"
    expect(closed.size).toBe(0);
  });
});

describe("findSnippet", () => {
  const code = "Map<String, Long> countByCity = users.stream()\n        .collect(Collectors.groupingBy(User::getCity));";

  it("原样片段直接定位", () => {
    const hit = findSnippet(code, "users.stream()");
    expect(hit).not.toBeNull();
    expect(code.slice(hit!.start, hit!.end)).toBe("users.stream()");
  });

  it("模型改了缩进/换行也能放宽空白匹配上", () => {
    const hit = findSnippet(code, ".collect(Collectors.groupingBy(User::getCity));");
    expect(hit).not.toBeNull();
    expect(code.slice(hit!.start, hit!.end)).toContain("groupingBy");
  });

  it("代码里没有的片段返回 null(不高亮,不报错)", () => {
    expect(findSnippet(code, "flatMap(x -> x)")).toBeNull();
    expect(findSnippet(code, "   ")).toBeNull();
  });

  it("正则元字符按字面量处理", () => {
    expect(findSnippet("a.b(c)", "a.b(c)")).toEqual({ start: 0, end: 6 });
  });
});

describe("codeSegments", () => {
  const code = "abcdefghij"; // 10 个字符

  it("没高亮时按已敲/未敲切成两段", () => {
    expect(codeSegments(code, 4, null)).toEqual([
      { start: 0, end: 4, isTyped: true, isHighlight: false, isAuto: false },
      { start: 4, end: 10, isTyped: false, isHighlight: false, isAuto: false },
    ]);
  });

  it("高亮区跨越光标时切成三段,已敲/未敲各自保留", () => {
    const segs = codeSegments(code, 4, { start: 2, end: 7 });
    expect(segs).toEqual([
      { start: 0, end: 2, isTyped: true, isHighlight: false, isAuto: false },
      { start: 2, end: 4, isTyped: true, isHighlight: true, isAuto: false },
      { start: 4, end: 7, isTyped: false, isHighlight: true, isAuto: false },
      { start: 7, end: 10, isTyped: false, isHighlight: false, isAuto: false },
    ]);
  });

  it("分段永远无缝覆盖整段代码", () => {
    for (const hl of [null, { start: 0, end: 10 }, { start: 3, end: 4 }]) {
      const segs = codeSegments(code, 6, hl);
      expect(segs[0].start).toBe(0);
      expect(segs[segs.length - 1].end).toBe(code.length);
      expect(segs.map((s) => code.slice(s.start, s.end)).join("")).toBe(code);
    }
  });

  it("IDE 已经帮你补好的闭括号单独切出来标记 isAuto", () => {
    // 光标在 3,位置 6 是自动补出来的闭括号 → 单独一段
    const segs = codeSegments(code, 3, null, [6]);
    expect(segs).toEqual([
      { start: 0, end: 3, isTyped: true, isHighlight: false, isAuto: false },
      { start: 3, end: 6, isTyped: false, isHighlight: false, isAuto: false },
      { start: 6, end: 7, isTyped: false, isHighlight: false, isAuto: true },
      { start: 7, end: 10, isTyped: false, isHighlight: false, isAuto: false },
    ]);
  });

  it("光标已经走过的自动补位置不再单独标记(它已经算已敲)", () => {
    expect(codeSegments(code, 8, null, [6])).toEqual([
      { start: 0, end: 8, isTyped: true, isHighlight: false, isAuto: false },
      { start: 8, end: 10, isTyped: false, isHighlight: false, isAuto: false },
    ]);
  });

  it("一个字都没敲 / 全敲完时不产生空段", () => {
    expect(codeSegments(code, 0, null)).toEqual([{ start: 0, end: 10, isTyped: false, isHighlight: false, isAuto: false }]);
    expect(codeSegments(code, 10, null)).toEqual([{ start: 0, end: 10, isTyped: true, isHighlight: false, isAuto: false }]);
  });
});

describe("指标计算", () => {
  it("WPM 按 5 字符 = 1 词", () => {
    expect(calcWpm(300, 60_000)).toBe(60);
    expect(calcWpm(0, 60_000)).toBe(0);
    expect(calcWpm(100, 0)).toBe(0);
  });

  it("正确率 = 敲对 / 总按键", () => {
    expect(calcAccuracy(95, 5)).toBe(95);
    expect(calcAccuracy(0, 0)).toBe(100);
  });

  it("用时文案", () => {
    expect(durationLabel(45_000)).toBe("45 秒");
    expect(durationLabel(83_000)).toBe("1 分 23 秒");
  });

  it("行数", () => {
    expect(lineCount("a\nb\nc")).toBe(3);
    expect(lineCount("")).toBe(0);
  });

  it("自评建议:错太多打回、够快够准算清楚", () => {
    expect(suggestGrade(80, 40)).toBe("forgot");
    expect(suggestGrade(93, 40)).toBe("vague");
    expect(suggestGrade(99, 10)).toBe("vague");
    expect(suggestGrade(99, 45)).toBe("clear");
  });
});
