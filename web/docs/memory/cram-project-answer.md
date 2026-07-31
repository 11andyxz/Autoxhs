# Feature Memory: 结合我的项目(猛攻版卡片的简历版回答)

## 基本信息

- 功能名称:结合我的项目 / project answer(「对应简历猛攻版」的第二份回答)
- 创建日期:2026-07-31
- 最后更新:2026-07-31
- 当前状态:已完成
- 相关文件:
  - `web/lib/job-hunter/interview/projectAnswer.ts` —— 纯逻辑(挑输入 / 简历取文 / 清洗输出)
  - `web/lib/job-hunter/interview/projectAnswer.test.ts` —— 上面这些的单测(14 例)
  - `web/lib/job-hunter/interview/prompt.ts` —— `CRAM_PROJECT_ANSWER_SYSTEM`
  - `web/lib/job-hunter/interview/ai.ts` —— `answerFromMyProjects()`(纯文本调用,52s 超时)
  - `web/lib/job-hunter/interview/cram.ts` —— `project_answer` 列 + `setCramCardProjectAnswer()`
  - `web/app/api/job-hunter/interview/cram/project-answer/route.ts` —— POST 生成 / PUT 手改 / DELETE 清空
  - `web/app/api/job-hunter/interview/cram/card/route.ts` —— 列表多返回 `projectAnswer`
  - `web/app/job-hunter/interview/cram/page.tsx` —— `ProjectAnswerSection` 组件 + `CramCard.projectAnswer`
- 相关接口:`/api/job-hunter/interview/cram/project-answer`(POST/PUT/DELETE)
- 相关数据表:`ip_cram_card`(新增列 `project_answer MEDIUMTEXT NULL`)

## 功能目标

题库导入的问答卡(如「Types of Exceptions and how do you deal with exceptions in your project?」)
只有一份**教科书式**答案。用户要的是:**原答案一字不动**,在它**下面**再加一份「按我简历里的
项目怎么答」的第一人称回答 —— 面试当场先讲理论、再讲自己项目里的落地。

## 实现方案

- **另存一列,不动 content**:新增 `ip_cram_card.project_answer`。
  - 否决「拼进 content 用分隔线」:重生成会重复追加、原答案再也拆不干净,而且 content 有 8000 截断。
  - 否决「塞 extra_json」:`addCramCard` 里是 `JSON.stringify(extra).slice(0, 4000)` —— 对 JSON 串
    做 slice 一超长就变成非法 JSON,不能往里放长文本。
- **迁移**:`ensureCramSchema()` 里 `execIgnoring("ALTER TABLE ... ADD COLUMN", ["ER_DUP_FIELDNAME"])`,
  和 FSRS 那几列同一套幂等写法(不查 information_schema —— 见 `aiven-information-schema-lag` 记忆)。
- **AI**:一次纯文本调用(不上 JSON schema,输出就是要直接念的一段话)。系统提示要求:
  只能用简历里出现的项目/公司/技术/数字;和原答案**同语言**(题库是英文 → 英文);第一人称、
  45-75 秒可口述;简历里确实没有相关经历时,只输出一行中文「（简历里没有直接相关的项目经历…」
  而不是编一个项目。
- **简历从哪来**:这张卡所属 session 的 `resume_html`(猛攻版一份简历一个 session,题库就是导进
  这个 session 的),服务端转纯文本、从**开头**截 14000 字(简历在前、后来追加的复习资料在后)。
- **前端**:`ProjectAnswerSection` 挂在 block 卡揭示答案之后。有内容 → 靛蓝框显示(走
  `CramSelectable`,所以简历版回答里也能划词翻译/加词);没有 → 一个「🧩 结合我的项目回答」按钮。
  带 重新生成 / 改 / 删除。

## 关键代码位置

- `web/lib/job-hunter/interview/projectAnswer.ts:24` —— `projectAnswerInputs()`:没有 front 的知识块
  用正文开头当题面;正反面全空返回 null(不去问模型)
- `web/lib/job-hunter/interview/projectAnswer.ts:45` —— `resumeTextFromHtml()`:保留分段/项目符号
- `web/app/api/job-hunter/interview/cram/project-answer/route.ts:28` —— POST(生成即覆盖)
- `web/app/job-hunter/interview/cram/page.tsx` —— `ProjectAnswerSection`(本地状态先行)

## 历史经验查询

- 查过:`natively-cluely-ai-assistant/docs/memory/ai-interview-copilot.md`(唯一的 memory 文件)、
  全仓 grep `我的项目 / projectAnswer / project_answer`、代码注释里的历史结论 —— **没有相关历史记录**,
  这是第一次做。
- 复用:`refineAnswer / answerAboutResume` 的调用形态(52s 超时压在路由 maxDuration=60 内)、
  FSRS 列的幂等 ADD COLUMN 写法、`CramSelectable` 的划词能力。
- 要避开的坑:见下面 ISSUE-001 / ISSUE-002。

## 问题与解决方案

### ISSUE-001:不能复用 cram/session 路由里的 htmlToText

- 日期:2026-07-31
- 相关文件:`web/app/api/job-hunter/interview/cram/session/route.ts:19`
- 问题表现:那份 `htmlToText` 把整份简历压成**一行**(`\s+` → 空格),因为它的输出是
  `resumeHash()` 的输入。

**根本原因**

两个用途冲突:
1. hash 用途要求**字节稳定** —— 改一个字符,所有 session 的 `resume_hash` 全漂移,
   同一份简历再上传会新建 session、老卡片进度看不见了(`uniq_cram_resume_hash` 去重失效)。
2. 喂模型要求**保留结构** —— 压成一行后,模型分不清「哪几条业绩属于哪个项目」,
   很容易把 A 项目的数字安到 B 项目上。

**失败的尝试**

1. 直接 import `lib/job-hunter/align.ts` 的 `htmlToText` —— 结果:能用但不该用。
   那个模块顶层 `import { getClient } from "@/lib/openai"`,纯逻辑模块跟着拖进 OpenAI 客户端,
   单测也要连带加载 SDK。
2. 改 session 路由那份让两边共用 —— 没做,理由见上(会让 resume_hash 漂移)。**以后也别改它。**

**最终解决方案**

在 `projectAnswer.ts` 里单独实现 `resumeTextFromHtml()`:`<br>`→换行、`<li>`→`\n• `、
块级闭合标签→换行,再压多余空行。仓库里因此有三份 htmlToText,各有各的约束,注释里写清了原因。

**验证方式**

`npx vitest run lib/job-hunter/interview/projectAnswer.test.ts` 里的
「段落之间不会粘成一行」「保留分段与项目符号」两例。

### ISSUE-002:生成完 UI 不刷新(靠 onChanged 回流是错的)

- 日期:2026-07-31
- 相关文件:`web/app/job-hunter/interview/cram/page.tsx`(`CramReview` → `CramFlashcard`)

**根本原因**

复习面板的 `queue` 是**开轮那一刻**从 `cards` 拷的快照,`onChanged`(=`loadCards`)只更新
`cards`,不会重建 `queue`;而 `CramFlashcard` 用 `key={card.id}` 挂载,也不会因为 props 变化重置。
所以「生成成功 → 调 onChanged → 等 card.projectAnswer 变新」这条路在复习界面里永远不会亮。

**最终解决方案**

`ProjectAnswerSection` 以自己的 `text` state 为准(初值取 `card.projectAnswer`),接口返回什么就
显示什么,同时照常调 `onChanged()` 让下面的卡片清单保持一致。

**验证方式**

见 TC-002(在复习界面第 1/296 张上生成/改/取消,页面立刻反映,且不用刷新)。

### ISSUE-003(避坑记录):行首多一个空格

`<p>` 这类**开标签**被统一换成空格后,换行紧跟一个空格 → 文本每段行首多一个空格。
在 `resumeTextFromHtml()` 里加 `.replace(/\n[ \t]+/g, "\n")` 收掉(单测里钉住了)。

## 测试用例

### TC-001:纯逻辑单测(14 例,自动化)

- 测试目标:输入挑选 / 简历取文 / 输出清洗的边界
- 自动化位置:`web/lib/job-hunter/interview/projectAnswer.test.ts`
- 覆盖:问答卡取 front 当题面;无 front 用正文前 300 字;正反面全空(含纯空白/null)→ null;
  题面超 2000 截断;脚本样式被剥掉、实体解码、`<li>`→`• `、段落不粘连、行首无空格;
  简历从开头截 14000;<80 字不算可用简历;```围栏剥离;空白输入 → 空串;超 8000 截断
- 预期结果:全部通过
- 实际结果:PASS(14/14);全量 `npx vitest run` = 39 文件 / 547 例 全绿
- 最后验证:2026-07-31

### TC-002:核心成功路径(手动,真库真模型)

- 前置条件:`cd web && npm run dev:verify`(3111 + `.next-verify`,别和用户的 3100 抢 `.next`)
- 操作步骤:
  1. `GET /api/job-hunter/interview/cram/sessions` → session 3(354 张卡 / 296 到期)
  2. 打开 `/job-hunter/interview/cram?session=3` → 开始复习 → 显示内容(第 1/296 张 = 卡 118
     「Types of Exceptions…」)
  3. 点「🧩 结合我的项目回答」
- 预期结果:15-20s 后原答案下方出现靛蓝框,英文第一人称,只用简历里的项目/数字;原答案不变
- 实际结果:PASS。17.8s 返回 1082 字;内容点到 Stripe merchant-support platform、Java 17/Spring
  Boot、Kafka/MongoDB/Redis、Prometheus+Grafana、35% tier-1 自动解决 —— 全部在简历里;
  `content` 与 FSRS 进度未变。卡 330(runnable vs callable)从空状态点生成 = 15.4s,写出的是
  Visa Token Service 那段(换题换项目,没有串项目)
- 最后验证:2026-07-31

### TC-003:落库 + 手改 + 删除(手动,curl)

- 操作步骤 / 预期 / 实际(全 PASS):
  1. 生成后 `GET /cram/card?sessionId=3` → 卡 118 `projectAnswer` 1082 字,`content` 原样 → PASS
  2. `PUT {cardId, projectAnswer}` → 首尾空白被 trim 后落库,读回一致 → PASS
  3. 再 `POST` 同一张 → 覆盖成新的一份(不追加、不重复) → PASS
  4. `DELETE ?id=330` → `projectAnswer` 空,`content`/`state`/`isDue` 不受影响 → PASS
  5. `PUT` 空白串 → 视为清空(存 NULL) → PASS
- 最后验证:2026-07-31

### TC-004:主要失败路径(手动,curl)

| 输入 | 预期 | 实际 |
| --- | --- | --- |
| `POST {}` | 400 缺少卡片 id | PASS |
| `POST {cardId: 99999999}` | 404 这张卡不存在 | PASS |
| `POST` 非法 JSON body | 400 请求格式有误 | PASS |
| `POST {cardId: 227}`(记忆图卡) | 400 记忆图卡不支持 | PASS |
| `DELETE` 不带 id | 400 缺少卡片 id | PASS |
| `PUT projectAnswer: 123` | 400 没有要保存的内容 | PASS |
| `PUT` 8001 字 | 400 这段太长了 | PASS |

- 最后验证:2026-07-31

### TC-005:前端交互(手动,浏览器)

- 操作步骤:复习界面点「✏️ 改」→ 出 textarea(带当前全文)→ 点「取消」→ 还原;
  卡片清单展开卡 330 → 空状态按钮 →点击变「按简历生成中…」→ 完成后原地换成靛蓝框
- 预期结果:状态切换正确,无 console 报错,无服务端报错
- 实际结果:PASS(console 无日志;dev 日志只有 200)
- 最后验证:2026-07-31

## 回归测试

- [x] TC-001(自动化,改动这块必须重跑)
- [x] TC-002 / TC-003 / TC-004 / TC-005(手动)
- [x] 原有全量单测 547 例(39 文件)

## 未解决问题

- **「简历没有正文」那条 400 分支只在单测层面覆盖**(`hasUsableResume`),路由层没真跑过 ——
  要跑得先建一个正文极短的 session,而目前没有删除 session 的接口,会在库里留垃圾数据。
- 没有**批量**生成(296 张要一张张点)。想要的话再加个「整份批量补齐」的接口(注意 OpenAI 并发
  和 Vercel 60s 限制)。
- 只做了猛攻版的 block 卡。面试复习中心的知识块(`ip_knowledge`)和题库(`ip_question`)还没有这一份。

## 后续优化

- 生成时把「这道题所属分类/公司」一起给模型,答案能更贴该公司的面试口径。
- 简历版回答也接上 TTS(`/cram/speak`),练口述。

## 更新日志

### 2026-07-31

- 完成:`project_answer` 列 + 生成/手改/删除接口 + 复习卡与卡片清单的展示编辑
- 新增测试:`projectAnswer.test.ts`(14 例)+ TC-002~TC-005 手动用例
- 变更原因:题库答案是教科书式的,面试要说的是「我项目里怎么做的」;用户要求保留原答案、
  在下面另加一份简历版
