/**
 * 卡片「正面」的去重键:截断到入库长度 → 折叠空白 → 转小写。
 * 同一道题在 Excel 里换了行/多打了空格/大小写不同,都算同一道,导入时跳过。
 *
 * 纯函数、不碰数据库,所以客户端(导入前预检:告诉用户会跳几道)和
 * 服务端(实际落库前过滤)共用同一套口径,不会出现「预检说跳过、实际又插进去」。
 */
const MAX_FRONT = 2000; // 与 ip_cram_card.front 的入库截断保持一致

export function frontKey(s: string): string {
  return s.slice(0, MAX_FRONT).replace(/\s+/g, " ").trim().toLowerCase();
}
