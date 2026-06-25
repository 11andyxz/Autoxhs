import { embedTexts } from "./ai";
import { hasKb, retrieveKbChunks } from "./repo";

/**
 * 知识库检索:有库才嵌入查询并取 top-k 片段;无库返回空(省一次嵌入调用)。
 * 失败时静默降级为空数组——知识库是增强项,不应阻断出题/评分主流程。
 */
export async function kbContextFor(query: string, k = 5): Promise<string[]> {
  try {
    if (!(await hasKb())) return [];
    const [vec] = await embedTexts([query]);
    return vec ? await retrieveKbChunks(vec, k) : [];
  } catch (err) {
    console.error("[interview:kb] 检索失败,降级为无知识库", {
      name: (err as { name?: string } | null)?.name ?? "Unknown",
    });
    return [];
  }
}
