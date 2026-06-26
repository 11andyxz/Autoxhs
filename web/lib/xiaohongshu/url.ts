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
