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
- **默认项目**(2026-07-31 追加):`ip_cram_session.preferred_project VARCHAR(120)`,猛攻页头部
  「🧩 简历版回答默认讲：___ 改」(`PreferredProject` 组件 → `PUT /cram/session {id, preferredProject}`)。
  提示词里的规则:给了默认项目就**优先用它讲**(哪怕另一个项目更新、更亮眼),只有这道题跟它
  真的不沾边才换别的、且不作说明;没给默认项目时,机制类题目挑「简历 bullet 对该机制最具体」的
  那个项目(有实测延迟/JVM/缓存/DB/队列细节的),而不是挑最近的那份工作。
  **当前值:session 3 和 5 都设成 `Visa Token Service (VTS)`** —— 用户的判断是 Visa 那段更贴 Java
  基础题(G1 调优、Hazelcast near-cache、Oracle 分区、ISO 8583、幂等 producer 都是机制级的),
  Stripe 那段偏 AI/平台层,纯 Java 机制题上答案容易飘。

- **代码佐证**(2026-07-31 追加):`ip_cram_session.code_path` 指向本机一个代码库
  (当前:`<仓库根>/payment-token-service`,用户按简历 Visa 那段写的 Java 多模块 demo,约 15k 行)。
  生成时按「题面 + 原答案」的词面相关度挑最多 5 个文件、每个截 4000 字,连同文件树喂给模型;
  提示词要求**逐字**引用、标出文件路径、每段 5-20 行,挑不到相关代码就整节不出现。
  回答里的 ```围栏``` 由前端渲染成深色代码块(可横向滚动 + 复制),散文段照常可划词。
  - **这是「读本机文件 → 发给 OpenAI」的接口,守卫比功能重要**:公网模式
    (`NEXT_PUBLIC_DEPLOY_MODE=public`)整体关闭(`/api/job-hunter/*` 在公网白名单里,不能变成
    任意本地文件读取的口子);路径必须绝对 + 是目录 + realpath 后仍在允许根目录内
    (默认仓库根,`CRAM_CODE_ROOT` 可改);只读代码/配置扩展名,跳过 `.env`/密钥/证书/lock,
    跳过 node_modules/target 等目录;文件数、单文件大小、总读取量、喂模型字符数都有上限。

- **就地追问**(2026-07-31 追加):`ip_cram_card.followups_json` —— 针对这张卡(常常是回答里
  那段代码)问一句,问答**留在这张卡里**跟着复习,不另起卡片、不弹独立面板(那是阅读区
  `AskPanel` 干的事,会新起一段问答)。代码块头部有「💬 追问这段」,点了在卡片底部的追问区
  带上这段代码;也可以不选代码直接问整张卡。追问同样吃代码库(查询词 = 问题 + 圈中的代码),
  所以「这个方法在哪被调用」能答到真文件。回答本身也能带代码块(同一套渲染)。
  - 前端总线用了一个**独立的 context `CardAsk`**,与工作台的 `CramActions` 分开:
    后者是「把选中的文字送去共享面板」,前者刻意不离开这张卡。

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

### ISSUE-004:回答带代码块后,`cleanProjectAnswer` 会把中间的散文全吃成代码

- 日期:2026-07-31
- 相关文件:`web/lib/job-hunter/interview/projectAnswer.ts`

**根本原因**

原来的剥围栏正则 `/^```[^\n]*\n([\s\S]*?)\n?```$/` 两端都有锚点。回答里只有一段时没问题;
加了「代码佐证」之后,回答常常**以代码块结尾**,一旦它又**以代码块开头**,这个正则就会从
第一个 ``` 匹配到最后一个 ```,把两个标记之间的所有东西(包括中间那段要说的话)当成
「被整段包起来的内容」原样留下 —— 表现是散文变成代码块、整段答案错位。

**最终解决方案**

只有当全文**恰好只有一对**围栏(`(t.match(/^```/gm)||[]).length === 2`)时才尝试剥。
单测「回答里带多个代码块时,别把首尾两个围栏当成整段被包起来剥掉」钉住了这条。

**后续注意**

任何「整段被 ``` 包住就剥掉」的清洗逻辑,只要输出可能**内含**代码块,都要先数围栏数量。

### ISSUE-005:词频会盖过「命中了几个不同的词」(挑错文件)

- 日期:2026-07-31
- 相关文件:`web/lib/job-hunter/interview/codeRank.ts`

**根本原因**

第一版打分:路径命中 +8,正文每命中一次 +1(封顶 6),再按命中的不同词数 ×(1+0.15n)。
实测(单测直接抓到):一个 `cache` 出现 30 次的配置类得 7.9 分,而 `cache` 和
`detokenization` 各出现一次的那个类只有 3.0 分 —— 恰恰是后者才同时讲了这两件事。
封顶值(6)比 distinct 加成(最多 ×2.2)量级大太多,注释写的意图和代码行为对不上。

**失败的尝试**

1. 只把封顶从 6 调到 2.5 —— 仍然是 3.3 vs 3.0,靠调参数勉强反超,换个词长就又翻过来,太脆。
2. 只加大 distinct 系数 —— 同样是拼参数,没有解释力。

**最终解决方案**

改成每个命中词各自计分再相加(类 BM25 的思路):
`rarity(词长 1.19x~2x) × (路径命中 3 + 词频 1.0~1.5(log 饱和))`。
词频最多只带来 50% 加成,所以「命中多个不同词」天然占优;长词(detokenization)权重更高。
上面那组用例变成 3.19 vs 1.97,差距来自结构而不是调参。

**验证方式**

`npx vitest run lib/job-hunter/interview/codeRank.test.ts` 的四条 scoreText 用例
(路径 > 正文、多词 > 刷词、长词 > 短词、测试文件不排除只降权)。

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

### TC-006:默认项目(手动,真库真模型)

- 测试目标:设了默认项目后,能答的题一律用它讲;真的答不上时才换别的项目
- 操作步骤 / 实际结果(全 PASS):
  1. `PUT /cram/session {id:3, preferredProject:" Visa Token\n Service (VTS) "}` → 归一化成
     `Visa Token Service (VTS)` 落库,GET 读回一致
  2. 重新生成卡 118(异常处理,原来讲的是 Stripe)→ **改讲 Visa**:controlled application-level
     响应而不是 500、Spring MVC 集中异常处理、Oracle vault / HSM / Kafka 幂等 producer、
     fail-fast + JUnit/Mockito、99.95% —— 比 Stripe 版明显更贴 Java 机制
  3. 生成卡 65(RAG:BM25+FAISS/query rewriting/MMR,Visa 完全不沾边)→ **自动换回 Stripe**,
     且跟着原答案的语言用了中文
  4. 页面头部显示「🧩 简历版回答默认讲：Visa Token Service (VTS) 改」;改 → 保存 → 立刻反映、
     落库;取消 → 还原
  5. `PUT {id}` 什么都不传 → 400;只传空白 resumeHtml → 400(「追加复习资料」老用法未受影响)
- 最后验证:2026-07-31

### TC-007:代码佐证(手动,真库真模型 + 真代码库)

- 前置条件:`PUT /cram/session {id:3, codePath:"<仓库根>/payment-token-service"}`
- 操作步骤 / 实际结果(全 PASS):
  1. **路径守卫**:相对路径 → 400「请填绝对路径」;`/etc` → 400「只能用 <root> 下面的目录」;
     指向 `pom.xml` → 400「请填一个目录」;不存在的目录 → 400;`…/Autoxhs/../../.ssh` → 400
     (realpath 后不在根内)
  2. 重新生成卡 118(异常处理)→ 18.5s,答案里 3 个 java 代码块,引用
     `common/…/ApiExceptions.java`、`common/…/ApiExceptionHandler.java`、
     `token-provisioning-service/…/TokenController.java`;**逐行 grep 核对,三段都是仓库里的原文**
     (`Release the claim so a genuine retry is not blocked forever…` 在 TokenController.java:74)
  3. 生成卡 330(Runnable vs Callable)→ 挑到 `IsoServerRunner.java`(守护线程跑 ISOServer)和
     `SuiteRunner.java`(要返回结果的回放步骤),代码同样逐字核对通过 —— 检索按题目选对了文件
  4. 生成卡 65(RAG)→ 这个仓库跟 RAG 无关 → **整节代码不出现**(0 个代码块),没有硬凑
  5. 前端:3 个深色代码块,`java` 标签、`overflow-x:auto`、复制按钮;页面不横向滚动;
     原答案里旧有的 ``` 代码块(追问存下来的 Feign/GraphQL 卡)现在也渲染成代码块;
     卡片清单一行预览不再以 ```java 开头
- 最后验证:2026-07-31

### TC-008:就地追问(手动,真库真模型)

- 操作步骤 / 实际结果(全 PASS):
  1. `POST /cram/card-followup {cardId:118, question:"这个 super 是什么意思？", snippet:<NotFoundException 那段>, ref:<文件路径>}`
     → 回答讲的是**这个类里**的 `super(message)` 把消息交给 `RuntimeException`,并指出 handler 里
     用 `e.getMessage()` 取出来(确是仓库里的写法),末尾一句通用规则
  2. 卡列表 GET 带出 `followups`;`content` 与 `projectAnswer` 未受影响
  3. 浏览器:复习卡底部出现追问区;代码块头部 5 个「💬 追问这段」(含追问回答里的代码块);
     点第 2 个 → 出现「针对 …ApiExceptionHandler.java」chip + 输入框自动聚焦 + placeholder 变成
     「比如：这个 super 是什么意思？」;提交 → 「思考中…」→ 新问答就地出现、chip 与输入框清空
  4. UI 提交的那条(为什么用 @ExceptionHandler 而不是 try/catch)回答同时引用了
     `ApiExceptionHandler` 和 `TokenController` 两处真实代码并做了对比 —— 追问也吃到了代码库
  5. 点某条的 ✕ → 该条消失、其余保留(删完又通过接口把这条有用的补了回来)
  6. 失败路径:没问题/空白问题 → 400;卡不存在 → 404;DELETE 少 cardId 或 id → 400
- 最后验证:2026-07-31

## 回归测试

- [x] TC-001(自动化:`projectAnswer.test.ts` 23 例 + `codeRank.test.ts` 11 例 +
      `followups.test.ts` 12 例,改这块必须重跑)
- [x] TC-002 ~ TC-008(手动)
- [x] 全量单测 593 例(42 文件)

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
- 追加:`preferred_project`(每份简历一个「默认项目」)+ 头部设置入口 + 提示词的项目选择规则;
  用户的两份 session 都设为 Visa Token Service (VTS)。新增 3 例单测(共 17)+ TC-006
- 追加:`code_path` + `codeContext.ts`(fs 侧,带安全守卫)/ `codeRank.ts`(打分截取,纯函数)
  + 提示词「Code:」小节 + 前端代码块渲染(顺带把原答案里的代码块也渲染了)。
  修了两个 Bug:ISSUE-004(多代码块被整段剥围栏)、ISSUE-005(词频盖过词覆盖导致挑错文件)。
  新增测试:`codeRank.test.ts` 11 例、`splitFencedBlocks` 5 例、多代码块清洗 1 例 + TC-007
- 追加:`followups_json` + `/cram/card-followup`(POST 问 / DELETE 删)+ 代码块「💬 追问这段」
  + 卡片底部追问区(`CardAsk` context 传递选中的代码)。新增 `followups.test.ts` 12 例 + TC-008
- 变更原因:题库答案是教科书式的,面试要说的是「我项目里怎么做的」;用户要求保留原答案、
  在下面另加一份简历版
