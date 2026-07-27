# 部署说明（面试复习工具 · 公网）

面向公网的「面试复习」工具部署在 Vercel,绑定域名 **https://tools.adxztech.com**。
`www.adxztech.com` 是另一个站点,不受影响。

## 自动部署（Git）
- Vercel 项目:`autoxhs-interview`(scope `andys-projects`)
- 关联仓库:`11andyxz/Autoxhs`,**生产分支 `main`**,**Root Directory = `web`**
- **推送到 `main` 即自动构建并上线。** 无需再手动 `vercel deploy`。
- 手动部署(可选):`cd web && npx vercel deploy --prod`

## 环境变量（在 Vercel 项目 Settings → Environment Variables，Production）
| 变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI(模型默认 gpt-5.5) |
| `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` | Aiven MySQL(与本地同一个库) |
| `APP_PASSWORD` | 全站登录密码(改这里 + 重新部署即可换密码) |
| `NEXT_PUBLIC_DEPLOY_MODE=public` | 只放行「求职/面试复习」相关路径,其它工具一律 404 |

> 密钥只放在 Vercel/本地 `.env.local`(已 gitignore),**不要进仓库、不要贴聊天**。

## 范围与鉴权
- `middleware.ts`:设了 `APP_PASSWORD` → 全站需登录;`NEXT_PUBLIC_DEPLOY_MODE=public` → 仅
  `/`、`/job-hunter`、`/api/job-hunter`、`/login`、`/api/auth` 放行,雇员PII/财务/发邮件/小红书/Indeed 均不对公网暴露。
- 本地不设这两个变量 → 登录门与范围限定都不生效,本机使用照旧。

## 注意事项
- **函数超时:300 秒,不是 60 秒。** 本项目已启用 **Fluid compute**,即使在 Hobby 计划下函数上限也是
  300s(查证命令见下)。`generate-preserve` 等路由声明的 `maxDuration = 300` 是**真实生效**的。
  > 早先本文写的「Hobby 上限 60s」是**旧信息、已作废**——那是未启用 Fluid 时的传统限制,别再照抄。
  > 查证:`GET https://api.vercel.com/v9/projects/<projectId>?teamId=<teamId>` →
  > `defaultResourceConfig.fluid = true`、`functionDefaultTimeout = 300`。
- **实测耗时**(本机,同一份简历 + 一份 FinTech JD):保留原格式整份改写约 **139s**;经典模板约 **43s**。
  两者都在 300s 内。若将来某条链路真顶到 300s,再考虑改造成
  「OpenAI `background: true` + 轮询 `responses.retrieve()`」——已验证 SDK(4.104)支持,每次请求都是秒级。
- **生成题库 / 技术八股文**:线上已**主动关闭**(见 `app/api/job-hunter/interview/build/route.ts` 里的
  `NEXT_PUBLIC_DEPLOY_MODE=public` 闸门 + 前端置灰),只在本地跑;存的是同一个 Aiven 库,线上立即可见。
- **Aiven 连接数上限低(76)**:连接池已挂 `globalThis` 防 dev HMR 泄漏(见 `lib/serviceFee/db.ts`)。
- 本地反复重启用根目录的 `./restart.sh`(杀旧进程 + 清 `.next` + 重启)。
