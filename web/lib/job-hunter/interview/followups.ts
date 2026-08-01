/**
 * 问答卡上的「就地追问」——针对这张卡(尤其是回答里贴的代码块)问一句,问答就留在**这张卡里**,
 * 不另起一张卡、不弹独立面板。存在 ip_cram_card.followups_json,复习时跟着卡一起显示。
 *
 * 这里是纯逻辑(解析/追加/裁剪/序列化),路由和前端共用同一套上限,免得两边对不上。
 */

export type Followup = {
  id: number;
  /** 问题 */
  q: string;
  /** 回答 */
  a: string;
  /** 针对哪段代码问的(文件路径或语言标记),没有就是针对整张卡问的 */
  ref?: string;
};

export const MAX_FOLLOWUPS = 30; // 一张卡最多留这么多条(超了丢最早的)
export const MAX_FOLLOWUP_Q = 500;
export const MAX_FOLLOWUP_A = 4000;
export const MAX_FOLLOWUP_REF = 200;
/** 追问时带上的代码片段上限(用户圈的那段,不是整个文件)。 */
export const MAX_FOLLOWUP_SNIPPET = 4000;

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** 宽松解析:坏 JSON / 形状不对的条目一律丢掉,绝不让一条脏数据把整张卡的追问全废掉。 */
export function parseFollowups(raw: string | null | undefined): Followup[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Followup[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const q = clean(o.q, MAX_FOLLOWUP_Q);
    const a = clean(o.a, MAX_FOLLOWUP_A);
    if (!q || !a) continue;
    const ref = clean(o.ref, MAX_FOLLOWUP_REF);
    const id = Number(o.id);
    out.push({ id: Number.isFinite(id) && id > 0 ? id : out.length + 1, ...(ref ? { ref } : {}), q, a });
  }
  return out.slice(-MAX_FOLLOWUPS);
}

/** 追加一条(id 自增,超上限丢最早的)。返回新数组,不改入参。 */
export function appendFollowup(list: Followup[], item: { q: string; a: string; ref?: string }): Followup[] {
  const nextId = list.reduce((m, f) => Math.max(m, f.id), 0) + 1;
  const ref = clean(item.ref, MAX_FOLLOWUP_REF);
  const next: Followup = {
    id: nextId,
    q: clean(item.q, MAX_FOLLOWUP_Q),
    a: clean(item.a, MAX_FOLLOWUP_A),
    ...(ref ? { ref } : {}),
  };
  return [...list, next].slice(-MAX_FOLLOWUPS);
}

export function removeFollowup(list: Followup[], id: number): Followup[] {
  return list.filter((f) => f.id !== id);
}

/** 空数组存 null(而不是 "[]"),让「没追问过」在库里就是 NULL。 */
export function serializeFollowups(list: Followup[]): string | null {
  return list.length ? JSON.stringify(list) : null;
}
