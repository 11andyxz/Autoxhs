/**
 * 小红书长文「分页/估算」相关的纯函数，单条页与批量页共用，避免逻辑重复。
 * 估算口径需与服务端 build_article_content 保持一致。
 */

// 清洗正文：去行尾空白、把连续多个空行合并成「最多一个空行」、去首尾空白。
export function collapseBlankLines(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 每张卡高度预算（≈填满一张），与服务端一致。
const MAX_CARD_HEIGHT = 27;

function visualLines(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return Math.max(1, Math.ceil(w / 40));
}

/**
 * 估算正文会被切成几张卡片：跳过空行；字数超 charsPerCard 或视觉高度超 MAX_CARD_HEIGHT 即切卡。
 * 注意：返回的是「正文卡片数」，不含封面；页面显示总图数时通常再 +1（封面）。
 */
export function estimateCardCount(body: string, charsPerCard: number): number {
  let cards = 0;
  let curLen = 0;
  let curHeight = 0;
  let has = false;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const lh = visualLines(line) + 0.8; // 行高 + 段间距
    if (has && (curLen + line.length > charsPerCard || curHeight + lh > MAX_CARD_HEIGHT)) {
      cards += 1;
      curLen = 0;
      curHeight = 0;
      has = false;
    }
    curLen += line.length + 1;
    curHeight += lh;
    has = true;
  }
  if (has) cards += 1;
  return Math.max(1, cards);
}

// 批量发布每张图字数策略：默认 380；若按 380 估算的「总图数（正文卡 + 封面）」超过 4 张，
// 则拉满到最高 500，压缩成更少的图。逐条独立判断。
export const DEFAULT_CHARS_PER_CARD = 380;
export const MAX_CHARS_PER_CARD = 500;
export const BATCH_IMAGE_THRESHOLD = 4;

export function pickCharsPerCard(body: string): number {
  const estimatedImages = estimateCardCount(body, DEFAULT_CHARS_PER_CARD) + 1; // +1 封面，与单条页显示口径一致
  return estimatedImages > BATCH_IMAGE_THRESHOLD ? MAX_CHARS_PER_CARD : DEFAULT_CHARS_PER_CARD;
}
