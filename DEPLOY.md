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
- **函数超时**:Vercel Hobby 函数上限 60s。**生成题库 / 技术八股文**较重(约 1 分钟,可能超时)——
  建议在**本地生成**(存同一个 Aiven 库,线上立即可见);复习/评分/单词/划词/发音等都在 60s 内,线上正常。
- **Aiven 连接数上限低(76)**:连接池已挂 `globalThis` 防 dev HMR 泄漏(见 `lib/serviceFee/db.ts`)。
- 本地反复重启用根目录的 `./restart.sh`(杀旧进程 + 清 `.next` + 重启)。
