# Feature Memory: 猛攻版复习卡「来源分类」

## 基本信息

- 功能名称:来源分类 / cram card category(「对应简历猛攻版」按卡片来源挑着复习)
- 创建日期:2026-08-05
- 最后更新:2026-08-05
- 当前状态:已完成
- 相关文件:
  - `web/lib/job-hunter/interview/cramCategory.ts` —— 分类口径 + 历史卡推断(纯逻辑)
  - `web/lib/job-hunter/interview/cramCategory.test.ts` —— 上面这些的单测(15 例)
  - `web/lib/job-hunter/interview/cram.ts` —— `source` 列 + `backfillCramSources()` + 各写入口带上 source
  - `web/app/api/job-hunter/interview/cram/card/route.ts` —— GET 返回 `category`;POST 收 `source`;PUT 可改分类
  - `web/app/api/job-hunter/interview/cram/import/route.ts` —— 批量导入标 `source: "import"`
  - `web/app/api/job-hunter/interview/coding/to-cram/route.ts` —— 标 `source: "coding"`
  - `web/app/job-hunter/interview/cram/page.tsx` —— `CategoryFilterBar` / `CategoryTag` / `CategoryPicker`
- 相关接口:`/api/job-hunter/interview/cram/card`(GET 带 category、POST 带 source、PUT 改 source)
- 相关数据表:`ip_cram_card`(新增列 `source VARCHAR(16) NULL`)

## 功能目标

360 张卡混在一个遗忘曲线队列里,分不清哪张是**自己追问追出来的**、哪张是**外部题库导进来的**、
哪张是**单词**。用户要按来源分好类,对应地复习。

六类(键 / 显示名):

| key | 显示 | 从哪来 |
| --- | --- | --- |
| `ask` | 💬 追问 | 阅读区选中一段 → 追问 → 「存成知识块」(front 是 `原文\n\n❓ 问题`) |
| `import` | 📥 题库导入 | `/cram/import`(Excel 题库批量导入) |
| `word` | 🔤 单词 | 划词 → 「加入单词卡」 |
| `note` | 🧠 划词知识块 | 划词 → 「加入知识块」(只有正文,没有题面) |
| `coding` | ⌨️ Coding 题 | Coding 跟打训练 → `/coding/to-cram` |
| `svg` | 📊 记忆图卡 | 选一大段生成的 SVG 卡 |

## 实现方案

- **落一个真列 `source`,不在读取时现算**。否决「每次列表按 front 形态现推」:
  1. 推断要用「同一秒插了几张」这种一次性信号,越往后越算不准;
  2. 归错了得能手改 —— 手改必须有地方存。
- **分类 = kind 优先,再看 source**:`word`/`svg` 由 `kind` 定死(渲染方式不一样,标成别的会和渲染打架),
  只有 block 卡的四类(ask/import/note/coding)能手改。PUT 传 `word`/`svg` 直接 400。
  好处:就算 source 被写脏,单词卡也永远显示成单词卡,不用多查一次 kind 来兜底。
- **历史 360 张一次性回填**(`backfillCramSources()`),判据全在纯函数 `guessLegacyCramSource()` 里:
  `kind` → `extra_json` 里的 `"source":"coding"` → 正面含 ❓ → 没有正面 → **同一秒的兄弟数 ≥ 5**。
  最后那条是关键:批量导入是一条 `INSERT ... VALUES` 多行,整批共用同一个 `NOW()`;而单张加卡
  (划词/追问/Coding)每张都要等一次 AI 往返,一秒攒不够 5 张。
- **幂等靠行为不靠 information_schema**(Aiven 上它会滞后,见根 CLAUDE 记忆):
  `ADD COLUMN` 吞 `ER_DUP_FIELDNAME`,回填只认「还有没有 `source IS NULL` 的行」。
- **筛选是复习面板和卡片清单共用一个 state**(提到 `CramWorkbench`)。刻意**不记 localStorage**:
  下次打开还停在某一类上,会让人以为卡片丢了。
- 换分类时把没答完的那一轮收掉(每张的进度在自评时已落库,不会丢),提示「点下面重新开始这一类」。

## 关键代码位置

- `web/lib/job-hunter/interview/cramCategory.ts:79` —— `guessLegacyCramSource()`,回填的全部判据
- `web/lib/job-hunter/interview/cram.ts:93` —— `backfillCramSources()`,取信号 + 算同秒簇 + 分批写回
- `web/app/job-hunter/interview/cram/page.tsx` —— `CategoryFilterBar`(筛选条)/ `CategoryPicker`(改分类)
- `web/lib/job-hunter/interview/cramCategory.test.ts` —— 15 例单测

## 历史经验查询

- 查过:`web/docs/memory/cram-project-answer.md`(同一个功能区的唯一记忆)、全仓 grep
  `ip_cram_card / source / 分类`、代码注释里的历史结论。**没有做过分类,这是第一次。**
- 复用:FSRS 列那套幂等 `ADD COLUMN`(`execIgnoring` + `ER_DUP_FIELDNAME`)、
  `extra_json` 里早就有的 `{"source":"coding"}` 约定(回填直接当证据用)。
- 要避开的历史坑:
  - `cram-project-answer.md` 的 **ISSUE-002**:复习面板的 `queue` 是开轮那刻从 `cards` 拷的快照,
    `loadCards()` 不会重建它。所以「换分类」必须**显式清空 queue**,不能指望 cards 变了队列就跟着变。
  - 根 CLAUDE 记忆「Aiven information_schema 滞后」:迁移幂等靠标记/行为断言,别信 information_schema。
  - 根 CLAUDE 记忆「Next dev 单实例」:验证用隔离的 `npm run dev:verify`(3111 / `.next-verify`),
    没去抢用户那个 3100 的 `.next`。

## 问题与解决方案

### ISSUE-001:front 里的 ❓ 标记不能靠截断后的文本判

- 日期:2026-08-05
- 触发条件:探查真库时用 `LEFT(front, 90)` 抽样,只找出 27 张带 ❓ 的追问卡
- 问题表现:实际有 70 张(`front LIKE '%❓%'` 才是对的)

**根本原因**

追问卡的 front 是 `选中的原文\n\n❓ 我的问题`,原文可以有一两千字,❓ 在很后面。
按前 N 个字判,长原文的追问卡全被漏成「题库导入」。

**最终解决方案**

`backfillCramSources()` 里**整条读 front** 再在 JS 里 `includes("❓")`(代码里注释写明了原因)。
没用 SQL 的 `LIKE '%❓%'`:判据集中在有单测的纯函数入口处更好验。
(❓ 是 U+2753,UTF-8 三字节,utf8mb3 连接也不会坏 —— 但读回来在 JS 里判,连这个都不用操心。)

**验证方式**

回填后 `SELECT COUNT(*) FROM ip_cram_card WHERE source='import' AND front LIKE '%❓%'` = 0。

### ISSUE-002(避坑记录):「有正面但不是批量」到底算什么

真库里只有 1 张(id=10「这个是怎么做到的？」)。它是**追问时没选中原文**的情况 ——
`front = passage ? \`${passage}\n\n❓ ${q}\` : q`,没选原文时 front 只剩问题本身、没有 ❓ 标记。
所以这一档归 `ask` 而不是 `import`。归错也不要紧:卡片清单里展开就能改。

### ISSUE-003:筛选状态活得比它的控件久 —— 面板卡在一个空分类上

- 日期:2026-08-05(多角度评审查出,已修)
- 相关文件:`web/app/job-hunter/interview/cram/page.tsx`(`CategoryFilterBar`)

**根本原因**

`shown` 只列 `total > 0` 的分类,而且 `shown.length <= 2` 就整条 `return null`;但 `category`
这个 state 在父组件 `CramWorkspace` 里,不会跟着回落。把某一类的最后一张卡改走(或删掉)之后,
筛选还生效着、切回「全部」的芯片却没了 —— 复习面板永远显示「本类 0 张」。

**最终解决方案**

当前选中的那一类**永远**留一枚芯片(哪怕 0 张);`return null` 只在 `value === "all"` 时才允许。

**验证方式**

TC-008(把仅有 1 张的 Coding 题改成追问 → 芯片变 `⌨️ Coding 题 0/0` 但还在,能点回全部)。

### ISSUE-004:筛选生效时新加的卡「像没保存」

- 日期:2026-08-05(多角度评审查出,已修)

**根本原因**

清单只渲染 `shown`、统计只算 `visible`,而所有写入口(加单词卡 / 加知识块 / 加图卡 / 导入题库)
都只是 `loadCards()`。筛在「追问」上时加一张单词卡:候选消失了、清单一张没多、统计纹丝不动,
看着像加丢了(其实已入库,只是不在当前分类里)。

**最终解决方案**

`loadCards` 记住上次见过的 id 集合;发现新卡且**没有一张**属于当前分类时,自动把筛选跳回「全部」。

**验证方式**

TC-009(筛在划词知识块 → 划词加一张单词卡 → 筛选自动回到全部,单词 60/153 → 61/154)。

### ISSUE-005:复习卡上的分类标签是开轮快照

- 日期:2026-08-05(多角度评审查出,已修)

**根本原因**

又是 `cram-project-answer.md` ISSUE-002 那个坑的新变种:`queue` 是 `start()` 那一刻从 `cards`
拷的快照,`loadCards()` 不重建它。本轮中途在下面清单里改了某张卡的分类,轮到它时卡片右上角
的 `CategoryTag` 还挂着旧分类,和下面清单里的图标当场自相矛盾。

**最终解决方案**

`cur` 不再直接取 `queue[idx]`,而是拿快照的 id 回 `cards` 里找最新那份(找不到才退回快照)。
**以后往复习卡上加任何「跟着数据变」的展示,都要走这条,别直接读 queue 里的对象。**

### ISSUE-006:自评在飞时换分类 → 下标被推乱

- 日期:2026-08-05(多角度评审查出,已修)

**根本原因**

`grade()` 是普通 async 函数,`await` 之后的 `idx + 1 >= queue.length` / `setIdx(idx + 1)` 读的都是
点击那一帧的闭包值。新加的「换分类清空队列」让「评分在飞 → 队列被换掉」第一次成为可能:
评分回来后照旧闭包推下标,新一轮会静默跳过前几张;若旧闭包正好是上一轮最后一张,还会把
刚开的新一轮整个清掉并弹「本轮复习完成 🎉」。成绩本身已落库,不丢数据。

**失败的尝试**

1. 想过给芯片和「开始复习」加 `disabled={grading}` —— 不做:自评往返有时要一秒,这段时间
   锁住整条筛选条,手感更差,而且挡不住「从清单点学习」那条开轮路径。

**最终解决方案**

轮次号码牌 `roundRef`:`start()` / 换分类 / 从空队列插队开轮 各 +1;`grade()` 在 await 前记下号码,
回来发现号码变了就只 `setGrading(false)` 然后 return。

### ISSUE-007:改分类的下拉会先弹回旧值

- 日期:2026-08-05(多角度评审查出,已修)

**根本原因**

`<select value={card.category}>` 是完全受控的,值只来自服务端拉回来的 `cards`。选完到
`loadCards()`(要把本 session 几百张卡连正文一起重新拉一遍)落地之间,下拉显示的还是旧分类,
而且 `setSaving(false)` 在刷新之前就跑了 —— 「保存中…」已经消失、值还是旧的,和「压根没点上」
看着一模一样。

**最终解决方案**

本地存一份乐观值 `pending`,刷新落地(`card.category === pending`)后自动交还给服务端值;
PUT 失败则清掉 pending 并显示「改分类失败」。

## 测试用例

### TC-001:分类口径与历史推断(自动化)

- 测试目标:`cramCategory()` / `guessLegacyCramSource()` / 常量表完整性
- 自动化位置:`web/lib/job-hunter/interview/cramCategory.test.ts`(15 例)
- 操作步骤:`cd web && npx vitest run lib/job-hunter/interview/cramCategory.test.ts`
- 预期结果:15 passed;含「真库 360 张的六种形态各一条样本」那例
- 实际结果:15 passed;全量 `npx vitest run` 45 文件 664 例全过
- 状态:PASS
- 最后验证:2026-08-05

### TC-002:回填历史卡(真库,一次性)

- 前置条件:`ip_cram_card` 有 360 张 `source IS NULL` 的历史卡(session 3)
- 操作步骤:起 `npm run dev:verify`(3111)→ 打开 `/job-hunter/interview/cram?session=3`
  → `ensureCramSchema()` 建列 + 回填
- 预期结果:word 153 / import 122 / ask 71 / note 12 / svg 1 / coding 1,合计 360;NULL 行 0
- 实际结果:完全一致(先用只读脚本预测,再跑真回填对账)
- 断言:`source='import' AND front LIKE '%❓%'` = 0;`source='ask' AND front 为空` = 0
- 状态:PASS
- 最后验证:2026-08-05

### TC-003:筛选条 + 队列只出这一类(手动,浏览器)

- 操作步骤:点「💬 追问 48/71」→ 四个统计块变 48/48/0/71 → 点「复习「追问」（48 张到期）」
- 预期结果:出现「第 1 / 48 张」,卡片右上角带 `💬 追问` 标签;下面卡片清单标题变
  「💬 追问（71 / 360）」
- 实际结果:一致(第一张正是 `making sure queries use partition pruning ❓ 这是咋做到的`)
- 状态:PASS
- 最后验证:2026-08-05

### TC-004:复习中途换分类(手动,浏览器)

- 操作步骤:队列进行中点「🔤 单词」
- 预期结果:队列收掉,提示「已切换分类，点下面重新开始这一类的复习。」,统计变 60/60/27/153
- 实际结果:一致(对应 ISSUE-002 那条历史坑:queue 是快照,必须显式清)
- 状态:PASS
- 最后验证:2026-08-05

### TC-005:手改分类(手动,浏览器 + 真库)

- 操作步骤:筛到「划词知识块」→ 展开第一张(id=220)→ 下拉选「💬 追问」
- 预期结果:PUT 成功;筛选条实时变 追问 49/72、划词知识块 9/11;该卡从当前清单消失
- 实际结果:一致;改回 `note` 后分布复原(12/71)
- 状态:PASS
- 最后验证:2026-08-05

### TC-006:主要失败路径(手动,curl)

| 请求 | 预期 | 实际 |
| --- | --- | --- |
| `PUT {id, source:"乱写"}` | 400「无效的分类。」 | 一致 |
| `PUT {id, source:"word"}` | 400「单词卡 / 记忆图卡的分类不能改。」 | 一致 |
| `PUT {id}`(空补丁) | 400「没有要修改的内容。」 | 一致 |

- 状态:PASS / 最后验证:2026-08-05

### TC-007:六条写入口都带对来源(手动,curl,真库,测完即删)

| 入口 | 请求 | 预期 category | 实际 |
| --- | --- | --- | --- |
| 追问存卡 | `POST {kind:"block", source:"ask"}` | ask | ✔ (id 406) |
| 划词知识块 | `POST {kind:"block"}` 不带 source | note | ✔ (id 407) |
| 单词卡 | `POST {kind:"word", source:"import"}`(乱传) | word | ✔ (id 408,kind 说了算) |
| 题库导入 | `POST /cram/import` 2 条 | import | ✔ (id 409/410) |
| Coding 转卡 | `POST /coding/to-cram {problemId:1}` | coding | ✔ (id 411) |
| 记忆图卡 | 与单词卡同一分支(`defaultCramSource(kind)`) | svg | 由既有 svg 卡显示为 📊 记忆图卡佐证 |

- 收尾:406~411 全部 DELETE,分布回到 360 张的原样
- 状态:PASS / 最后验证:2026-08-05

### TC-008:空掉的分类不会把人锁死(手动,浏览器 —— ISSUE-003 的回归)

- 操作步骤:筛到「⌨️ Coding 题」(全库只有 1 张)→ 展开它 → 分类改成「💬 追问」
- 预期结果:芯片变成「⌨️ Coding 题 0/0」但**仍在**;清单显示「这一类下面还没有卡片」;
  点「🗂 全部」能回到全量,并把那张卡改回 coding
- 实际结果:一致(修之前:芯片消失、面板内再无切回全部的入口)
- 状态:PASS / 最后验证:2026-08-05

### TC-009:筛选生效时新加的卡不会「像丢了」(手动,浏览器 —— ISSUE-004 的回归)

- 操作步骤:筛到「🧠 划词知识块」→ 阅读区划中 `Hibernate` → 「➕ 加入单词卡」
- 预期结果:筛选自动跳回「🗂 全部」,单词 60/153 → 61/154,新卡在清单里看得见
- 实际结果:一致(测试卡 id 412 已删,原有的 Hibernate 单词卡 id 19 未动)
- 状态:PASS / 最后验证:2026-08-05

### TC-010:改分类的下拉不回弹(手动,浏览器 —— ISSUE-007 的回归)

- 操作步骤:展开一张 block 卡 → 下拉换一个分类 → **立刻**读 `select.value`
- 预期结果:当场就是新值(乐观值),不等整份卡表刷新;PUT 失败则回退并提示
- 实际结果:立刻为新值(修之前会先弹回旧值)
- 状态:PASS / 最后验证:2026-08-05

## 回归测试

- [x] TC-001(自动化:`cramCategory.test.ts` 15 例;改分类口径必须重跑)
- [x] 全量单测 45 文件 664 例
- [x] `npx tsc --noEmit` 无错;`next lint` 改动文件无警告
- [x] TC-002 ~ TC-010(手动)
- 说明:ISSUE-005(复习卡标签用快照)/ ISSUE-006(自评在飞时换分类)是**结构性修复**,
  没有稳定的手动复现步骤(要卡在一次网络往返的窗口里),只做了代码层验证 + 换分类/开轮的冒烟。

## 未解决问题

- **回填是启发式的**,极端情况可能归错:一秒内手工连加 5 张以上会被当成「题库导入」;
  用「题库导入」这条路导进来的单条(< 5 条一批)会被当成「追问」。已给出手改入口(卡片清单里展开 → 下拉),
  归错了自己改,不当 Bug 修。
- 分类**没有下钻**(比如题库再按公司/章节分),按来源一层就够用。
- `source` 列**没建索引**:现在整份 session 的卡本来就一次全捞到前端筛,不需要。哪天改成服务端分页再加。
- 卡片清单和复习面板**共用**一个筛选:筛到某一类时,清单也只显示这一类(有意为之,顶部有「显示全部」)。

## 后续优化

- 面试复习中心的知识块(`ip_knowledge`)、题库(`ip_question`)也可以套同一套来源分类。
- 分类维度之外再加个「只看没背过的 / 只看忘过的」二次筛。

## 更新日志

### 2026-08-05

- 完成:`ip_cram_card.source` 列 + 历史 360 张一次性回填 + 六条写入口带上来源 +
  复习面板/卡片清单共用的来源筛选条 + 卡片上的分类标签 + 展开卡片里的「改分类」下拉
- 修复(四角度对抗式评审查出 19 条、复核确认 5 条,其余被驳回):ISSUE-003 空分类锁死、
  ISSUE-004 筛选生效时新卡像丢了、ISSUE-005 复习卡标签是快照、ISSUE-006 自评在飞时换分类
  推乱下标、ISSUE-007 改分类下拉回弹
- 新增测试:`cramCategory.test.ts` 15 例 + TC-002 ~ TC-010 手动用例
- 变更原因:用户 360 张卡混一个队列,想按「追问 / 外部题库导入 / 单词」分开对应地复习
