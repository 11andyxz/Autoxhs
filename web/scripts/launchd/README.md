# 小红书无人值守 · launchd 部署说明

让「每天自动评论」和「每小时自动发一篇」在本机无人值守运行。

## 三个 launchd 代理
- `com.autoxhs.engage-auto` — 每小时唤醒跑 `scripts/engageAuto.ts`（真发受 24h 闸门 + 总开关约束）。
- `com.autoxhs.auto-post` — 每 10 分钟唤醒跑 `scripts/autoPost.ts`（每小时发一篇，见下面「自动发布」一节）。
- `com.autoxhs.rednote` — 让本地 rednote 签名服务(3456) 开机自启 + 崩溃自愈（`KeepAlive`）。
  用 profile `k1ds45df`、端口 3456（改这两个就编辑 plist 里的 `XHS_ADS_USER_ID`/`XHS_PORT` 再重装）。

## 前提（都得开着）
- **AdsPower** 打开，并已登录目标小红书 profile（`k1ds45df`）。这一步仍需你手动，launchd 管不了。
- 本地 **rednote 服务(3456)** —— 现由 `com.autoxhs.rednote` 自动拉起，无需再手动 `restart.sh`。
- `web/.env.local` 配好 `OPENAI_API_KEY`、`DB_*`、`REDNOTE_API_BASE`。

## 一、先干跑验证（不会发布任何东西）
```bash
cd "/Users/andyxiongzheng/AndyXiongZheng LLC/Autoxhs/web"
npm run engage:auto:dry
```
会取推荐流 + 生成评论并打印「本应发布」的内容，但**不发、不点赞、不记录**。看内容满意再往下。

## 二、开启总开关
确认无误后，在 `web/.env.local` 里设：
```
ENGAGE_AUTO_ENABLED=1
```
（可选：同时调 `ENGAGE_AUTO_COUNT` / `_INTERVAL_HOURS` / `_LIKE_*` 等，见 `.env.example`。）

## 三、安装 launchd 代理（两个）
> 首次已由 Claude 装好；下面命令供重装/迁移/换机时用。

```bash
SRC="/Users/andyxiongzheng/AndyXiongZheng LLC/Autoxhs/web/scripts/launchd"
LA="$HOME/Library/LaunchAgents"

# A) 定时评论代理
cp "$SRC/com.autoxhs.engage-auto.plist" "$LA/"
launchctl load -w "$LA/com.autoxhs.engage-auto.plist"

# B) rednote 服务自启代理（先杀手动实例释放 3456，再交给 launchd 托管）
pkill -f "rednote/src/server.py"; sleep 2
cp "$SRC/com.autoxhs.rednote.plist" "$LA/"
launchctl load -w "$LA/com.autoxhs.rednote.plist"

launchctl list | grep autoxhs          # 两个都应在列
curl -s http://127.0.0.1:3456/rednote/health   # rednote 就绪确认
```
装载后各会立刻跑一次（RunAtLoad）；engage-auto 之后每小时检查一次，真正发评论受 24h 闸门 + 总开关约束。

> 若总开关还没开(ENGAGE_AUTO_ENABLED≠1)，engage-auto 装上也**只会打印提示、不发**，可以安全先装后开。

## 日志
```bash
tail -f ~/Library/Logs/autoxhs-engage-auto.log       # 脚本自身日志（带每篇结果）
tail -f ~/Library/Logs/autoxhs-engage-auto.err.log   # launchd 层面的错误
```

## 停止 / 卸载
```bash
# 临时停「发评论」（最常用）：把 .env.local 的 ENGAGE_AUTO_ENABLED 改回 0 即可，代理可继续挂着
launchctl unload ~/Library/LaunchAgents/com.autoxhs.engage-auto.plist   # 彻底停定时评论
launchctl unload ~/Library/LaunchAgents/com.autoxhs.rednote.plist       # 停 rednote 自启（会关掉 3456 服务）
```

## 常见排查
- 日志出现「本地浏览器当前不在已登录的小红书页面」→ AdsPower 里重新登录 xiaohongshu.com。
- 「取推荐流失败 / 无响应」→ rednote 服务(3456) 没在跑或没连上 AdsPower。
- 「距上次成功 x.xh < 24h，跳过」→ 正常，闸门在起作用。
- 想改「每天几篇 / 间隔 / 是否点赞」→ 改 `.env.local` 的 `ENGAGE_AUTO_*`，下次唤醒即生效（无需重装 plist）。
- 改了 plist 本身（如触发频率）→ 需 `unload` 再 `load` 一次。

---

# 自动发布（每小时一篇）

`com.autoxhs.auto-post` 每 **10 分钟**唤醒一次跑 `scripts/autoPost.ts`。每次只是「检查」：

1. 当天还没排期 → 现生成主题，**只排当前小时往后的整点**（中午才开机就排 12 点~23 点，不会倒填出一堆立刻到期的排期）；
2. 到点（整点已过）且距上一篇 ≥ `AUTO_POST_MIN_GAP_MIN` 分钟 → 领一个整点，跑完整条流水线发一篇；
3. 一轮最多发 1 篇。**关机错过的整点会留在库里**，开机后每轮补一个，按节流速度慢慢追上（不会一次性全推出去）。

一篇的流水线：联网查官方口径 → 写文案 → **再联网复核一遍事实** → 署名来源 → 拆设计卡 → 渲染 → 逐张上传 → 发布（带可点击话题 + 声明原创）。全程约 6~8 分钟。

## 先手动验收（不进定时器）
```bash
cd "/Users/andyxiongzheng/AndyXiongZheng LLC/Autoxhs/web"
npm run post:auto -- --plan-only                                  # 只看今天排了什么主题
AUTO_POST_ENABLED=1 npm run post:auto -- --now --count 1 --privacy 1   # 立刻发 1 篇「仅自己可见」
npm run post:auto:dry                                              # 干跑：会真渲染真上传，但不发布
```

## 开启
`.env.local`：
```
AUTO_POST_ENABLED=1
AUTO_POST_PRIVACY=0        # 先设 1 观察几篇，稳了再改 0 公开
AUTO_POST_MIN_GAP_MIN=6    # 补跑限速：调小补得快，但更容易触发风控
```
装代理：
```bash
SRC="/Users/andyxiongzheng/AndyXiongZheng LLC/Autoxhs/web/scripts/launchd"
cp "$SRC/com.autoxhs.auto-post.plist" "$HOME/Library/LaunchAgents/"
launchctl load -w "$HOME/Library/LaunchAgents/com.autoxhs.auto-post.plist"
tail -f ~/Library/Logs/autoxhs-auto-post.log
```

## 排期表 `xhs_auto_post`
一天 24 行（slot=整点）。`topic_key` 全表唯一 → 历史发过的主题不会再排进来。
状态：`pending → publishing → done`；失败是 `failed`（下一轮重试，最多 3 次）；
跨天没发的、以及「结果未知」的（脚本中途崩了）标 `missed` —— **不自动重试，避免重复发布**。

```sql
-- ⚠️ 别用 CURDATE()：DB 服务器是 UTC，晚上查会查成明天、返回空表。
-- plan_date 存的是**本机日期**（lib/.../autoPost/db.ts 的 localDate()），要显式写死那一天：
SELECT slot, topic, status, note_id FROM xhs_auto_post WHERE plan_date = '2026-07-27' ORDER BY slot;
```

## 排查
- 「AUTO_POST_ENABLED 未开启」→ 总开关没开，正常。
- 「距上一篇仅 x 分钟」→ 节流在起作用，正常。
- 「没有到点待发的排期」→ 这个整点已经发过了，正常。
- 「⚠️ 笔记已发布但没能写回数据库」→ 手动把那行 `xhs_auto_post` 改成 `done`，否则它会被当成未发。
- 「N 个标签一个都没匹配到话题」→ rednote 掉登录了，去 AdsPower 重登。
