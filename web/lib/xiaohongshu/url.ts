/** 小红书链接解析（纯函数，客户端/服务端通用，勿引入服务端依赖）。 */

/** 从小红书链接解析 note_id（路径最后一段）；解析失败返回 null。 */
export function parseNoteId(raw: string): string | null {
  try {
    const u = new URL((raw ?? "").trim());
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    return last || null;
  } catch {
    return null;
  }
}

/**
 * 从小红书笔记链接解析 { noteId, xsecToken }。
 * 看笔记详情/读正文需要 xsec_token，故两者都必须存在，否则返回 null。
 */
export function parseNoteRef(raw: string): { noteId: string; xsecToken: string } | null {
  try {
    const u = new URL((raw ?? "").trim());
    const parts = u.pathname.split("/").filter(Boolean);
    const noteId = parts[parts.length - 1] ?? "";
    const xsecToken = u.searchParams.get("xsec_token") ?? "";
    if (!noteId || !xsecToken) return null;
    return { noteId, xsecToken };
  } catch {
    return null;
  }
}
