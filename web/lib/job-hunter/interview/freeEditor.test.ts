import { describe, expect, it } from "vitest";

import { applyEditorKey, handleBackspace, handleCloser, handleEnter, handleOpen, handleTab, indentOf } from "./freeEditor";

describe("indentOf(本行缩进)", () => {
  it("取光标所在行开头的空白", () => {
    expect(indentOf("        return x;", 16)).toBe("        ");
    expect(indentOf("a\n    b", 7)).toBe("    ");
    expect(indentOf("no indent", 3)).toBe("");
  });
});

describe("Tab", () => {
  it("没选区就打四个空格", () => {
    expect(handleTab("ab", 2, 2)).toEqual({ value: "ab    ", cursor: 6 });
  });

  it("有选区就整块往右推一级(从行首推,不是从选区起点)", () => {
    const v = "a\nb";
    const r = handleTab(v, 0, 3);
    expect(r.value).toBe("    a\n    b");
  });

  it("Shift+Tab 退一级", () => {
    const v = "    a\n    b";
    const r = handleTab(v, 0, v.length, true);
    expect(r.value).toBe("a\nb");
  });
});

describe("回车", () => {
  it("继承本行缩进", () => {
    const v = "    int x = 1;";
    const r = handleEnter(v, v.length, v.length);
    expect(r.value).toBe("    int x = 1;\n    ");
    expect(r.cursor).toBe(v.length + 5);
  });

  it("行尾是开括号就多缩进一级", () => {
    const v = "    if (a) {";
    const r = handleEnter(v, v.length, v.length);
    expect(r.value).toBe("    if (a) {\n        ");
  });

  it("夹在 {} 中间 → 展开三行,闭括号回到原缩进", () => {
    const v = "    if (a) {}";
    const r = handleEnter(v, 12, 12); // 光标在 { 和 } 之间
    expect(r.value).toBe("    if (a) {\n        \n    }");
    expect(r.value.slice(r.cursor)).toBe("\n    }"); // 光标停在中间那行末尾
  });
});

describe("自动补括号", () => {
  it("补上配对的闭括号,光标停中间", () => {
    expect(handleOpen("f", 1, 1, "(")).toEqual({ value: "f()", cursor: 2 });
    expect(handleOpen("", 0, 0, "{")).toEqual({ value: "{}", cursor: 1 });
  });

  it("有选区 = 用括号把选中的包起来", () => {
    const r = handleOpen("a+b", 0, 3, "(");
    expect(r).toEqual({ value: "(a+b)", cursor: 5 });
  });

  it("右边紧挨着标识符就不补(不然 f|oo 里敲 ( 会插进一个孤零零的 ))", () => {
    expect(handleOpen("foo", 1, 1, "(")).toBeNull();
  });

  it("引号在单词中间不配对(don't 的那一撇)", () => {
    expect(handleOpen("dont", 3, 3, "'")).toBeNull(); // 右边是 t
    expect(handleOpen("don", 3, 3, "'")).toBeNull(); // 左边是 n
    expect(handleOpen("s = ", 4, 4, '"')).toEqual({ value: 's = ""', cursor: 5 });
  });
});

describe("闭括号跳过 / 退格删一对", () => {
  it("右边正好是同一个闭合符就跳过去,不多打", () => {
    expect(handleCloser("f()", 2, 2, ")")).toEqual({ value: "f()", cursor: 3 });
  });

  it("右边不是它就不接管(照常输入)", () => {
    expect(handleCloser("f(", 2, 2, ")")).toBeNull();
    expect(handleCloser("f()", 2, 3, ")")).toBeNull(); // 有选区不接管
  });

  it("退格删掉空的一对", () => {
    expect(handleBackspace("f()", 2, 2)).toEqual({ value: "f", cursor: 1 });
    expect(handleBackspace("f(a)", 3, 3)).toBeNull(); // 里面有东西,正常退格
    expect(handleBackspace("", 0, 0)).toBeNull();
  });
});

describe("applyEditorKey(总入口)", () => {
  it("普通字符不接管", () => {
    expect(applyEditorKey("a", 1, 1, "b")).toBeNull();
    expect(applyEditorKey("a", 1, 1, "ArrowLeft")).toBeNull();
    expect(applyEditorKey("a", 1, 1, "Shift")).toBeNull();
  });

  it("引号:先试跳过,再试补一对", () => {
    // "" 中间敲 " → 跳到右边去,不再补
    expect(applyEditorKey('""', 1, 1, '"')).toEqual({ value: '""', cursor: 2 });
    // 空白处敲 " → 补一对
    expect(applyEditorKey("x = ", 4, 4, '"')).toEqual({ value: 'x = ""', cursor: 5 });
  });

  it("敲一段完整的 for 循环:括号只会出现该有的那些", () => {
    // 模拟依次敲 "for" + "(" + "int i" ... 只验括号部分
    let v = "for";
    let c = 3;
    const open = applyEditorKey(v, c, c, "(")!;
    v = open.value;
    c = open.cursor;
    expect(v).toBe("for()");
    // 光标在中间,敲 ) 应当跳过而不是再插一个
    const close = applyEditorKey(v, c, c, ")")!;
    expect(close).toEqual({ value: "for()", cursor: 5 });
  });
});
