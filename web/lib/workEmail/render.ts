/**
 * 极简 markdown → HTML 渲染器(同构:前端预览与发信端 HTML 正文共用)。
 * 仅支持 ## 小标题 / - · 无序项 / "1." 有序项 / **加粗** / 空行分段。
 * 所有文本先做 HTML 转义,再套结构,因此对模型 / 用户输入是安全的(无法注入标签)。
 * 纯字符串处理,不依赖任何运行时(Node / 浏览器均可)。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 行内:**加粗**(在已转义的文本上处理) */
function inline(escaped: string): string {
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

type Block =
  | { kind: "h"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "p"; lines: string[] };

/** 把 markdown-lite 正文切分成块 */
function parseBlocks(body: string): Block[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  // 空行会「断开」列表:其后的项目符号应另起一个新列表,而不是并进上一个列表
  // (否则两段本应独立的列表会被合并,有序列表的编号也会错误地接着往下数)。
  let listBroken = false;

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: "p", lines: para });
      para = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushPara();
      listBroken = true;
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      blocks.push({ kind: "h", text: heading[1] });
      listBroken = false;
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (!listBroken && last && last.kind === "ul") last.items.push(bullet[1]);
      else blocks.push({ kind: "ul", items: [bullet[1]] });
      listBroken = false;
      continue;
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (!listBroken && last && last.kind === "ol") last.items.push(numbered[1]);
      else blocks.push({ kind: "ol", items: [numbered[1]] });
      listBroken = false;
      continue;
    }

    para.push(trimmed);
    listBroken = false;
  }
  flushPara();
  return blocks;
}

/**
 * 渲染为一段带内联样式的 HTML(适合放进邮件正文,邮件客户端不识别 <style>/class)。
 */
export function renderEmailHtml(body: string): string {
  const blocks = parseBlocks(body);
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "h") {
      out.push(
        `<h3 style="margin:20px 0 8px;font-size:16px;font-weight:700;color:#0f172a;">${inline(escapeHtml(b.text))}</h3>`,
      );
    } else if (b.kind === "ul" || b.kind === "ol") {
      const tag = b.kind === "ul" ? "ul" : "ol";
      const items = b.items
        .map((it) => `<li style="margin:4px 0;">${inline(escapeHtml(it))}</li>`)
        .join("");
      out.push(`<${tag} style="margin:8px 0;padding-left:22px;color:#334155;">${items}</${tag}>`);
    } else {
      const html = b.lines.map((l) => inline(escapeHtml(l))).join("<br/>");
      out.push(`<p style="margin:10px 0;color:#334155;line-height:1.6;">${html}</p>`);
    }
  }
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#334155;">${out.join(
    "",
  )}</div>`;
}
