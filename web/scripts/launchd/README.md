# 每天自动评论 · launchd 部署说明

让「每天自动给小红书笔记评论」在本机无人值守运行。核心：launchd 每小时唤醒一次跑
`scripts/engageAuto.ts`，脚本内部用 **24h 滚动闸门**（以上次成功为准）+ **总开关** 决定这次要不要真发。

## 两个 launchd 代理
- `com.autoxhs.engage-auto` — 每小时唤醒跑 `scripts/engageAuto.ts`（真发受 24h 闸门 + 总开关约束）。
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
