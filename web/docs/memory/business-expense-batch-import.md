# Feature Memory: Business 记账本 · 批量导入(一次上传出多笔收支)

## 基本信息

- 功能名称:业务记账本「批量导入 Batch Import」
- 创建日期:2026-07-31
- 最后更新:2026-07-31
- 当前状态:已完成(本机验证通过)
- 相关文件:
  - `web/lib/expense/batch.ts` —— 纯逻辑(文件类型分流、模型输出归一、去重键、合计)
  - `web/lib/expense/batch.test.ts` —— 上述纯逻辑的单测(15 例)
  - `web/lib/expense/parseBatch.ts` —— 服务端识别(pdf-parse / 多模态读图 / CSV 文本 → 模型抽多笔)
  - `web/app/api/business-expense/parse-batch/route.ts` —— 只识别,不写库
  - `web/app/api/business-expense/save-batch/route.ts` —— 复核后一次性入账(单事务)
  - `web/lib/expense/repo.ts:findExistingExpenseKeys` —— 查重用的「日期|金额」键
  - `web/app/business-expense/page.tsx:BatchImportSection` —— 上传 → 复核表 → 保存的界面
- 相关接口:`POST /api/business-expense/parse-batch`、`POST /api/business-expense/save-batch`
- 相关数据表:`exp_expense`(复用,无新表、无新列)

## 功能目标

以前记账只能「一笔一笔敲」:一份银行/信用卡流水有几十行,得开几十次表单。
现在:一次上传对账单 PDF / 账单截图 / CSV 流水 → 自动识别出每一笔 → 在表里逐行复核改 →
勾选的一次性入账。识别错、识别漏都能在保存前改掉,不会直接污染账本。

## 实现方案

主流程:

1. 前端选文件(可多选,≤10 个、单个 ≤20MB)→ `POST parse-batch`(multipart,附 `businessId` 与前端本地的 `today`)。
2. 服务端按扩展名分三条链路:
   - `pdf` → pdf-parse 提纯文本 → 模型结构化抽取
   - 图片 → 多模态 `input_image` + `detail:"high"`(截图小字不给 high 会读错金额)
   - `csv/txt` → 直接当文本喂模型
   并发 3 路,某一份失败不影响其余(逐份返回 `{name, count, error}`)。
3. 归一(`normalizeBatchRows`):金额去 `$`/千分位/括号;**原文带负号或括号 → 一律判为支出**;
   日期非法留空交给用户补;金额读不出的行直接丢(表头/余额/合计行就是这样被过滤掉的)。
4. 查重(`markDuplicates`):键 = `日期|金额(两位小数)`,既比库里已有的,也比本批次内先出现的;
   命中的行标「⚠ 可能重复」且**默认不勾选**。
5. 前端复核表:逐行可改(日期/类型/金额/类别/对方/付款方式/备注)、可删行、可批量填类别与付款方式、
   可整体设收支;每行按 `validateExpense` 同一套规则校验(类别必填)。
6. `POST save-batch`:再校验一遍(不信前端),单事务全部插入,失败整批回滚。

### 为什么这么选(以及否决了什么)

- **不复用 `parsePdf.ts`(抽「一笔」自动填表)**:那条链路的提示词与 schema 是「一张收据 = 一笔」,
  合成一条会互相拖累准确率。两条并存,`parseBatch.ts` 只管「一份流水 = 多笔」。
- **批量入账不落凭证文件**:一份对账单挂到 10 行上是噪音,且要重复存 10 份。
  需要发票的记录,在明细里编辑那一条再上传(界面上已写明)。
- **去重键只用 日期+金额,不含 vendor**:vendor 是模型清洗过的名字(`WAL-MART #2697 …` → `Wal-Mart`),
  写法不稳定,拿它做键会漏判。日期+金额够用;宁可多提示一次,也不要重复入账。
  真有同日同额的两笔,用户把勾打回去即可(界面有说明)。
- **负号优先于模型给的 type**:账单里的负号/括号是最硬的信号,模型偶尔会把 refund 判成 income。
- **`today` 由前端传**:账单常只有 `07/27` 没有年份,要用「不晚于今天」的最近年份推。
  服务器时区可能已经跨日,拿服务端的今天会把 12/31 推成明年。前端传的值仍会用 `isValidDateStr` 校验。
- **CSV 不写死列名解析**:各家银行导出的表头差异极大(Debit/Credit 两列、单列带负号、多余的 Balance/Total 行),
  交给模型比维护一堆列名映射稳。
- **`MAX_BATCH_ROWS = 200`**:超出部分截断并在界面提示分批,避免一次事务插几千行。

## 关键代码位置

- `web/lib/expense/batch.ts:95` —— `normalizeBatchRows`,负号/括号 → 支出的那段
- `web/lib/expense/batch.ts:132` —— `dupKey`,日期+金额两位小数
- `web/lib/expense/parseBatch.ts:38` —— 抽多笔的系统提示词(排除表头/余额/合计的规则在这里)
- `web/app/api/business-expense/parse-batch/route.ts:55` —— 固定并发 3 的 `mapWithLimit`
- `web/lib/expense/repo.ts:273` —— `findExistingExpenseKeys`(`IN (?)` 只能用 `query()`,`execute()` 不展开数组)

## 历史经验查询

- 动手前查过:`web/docs/memory/`、`natively-cluely-ai-assistant/docs/memory/`、代码里 expense 相关注释。
  **本功能此前没有任何记忆文件**,`cram-project-answer.md` 与 AI 面试的记录都与此无关。
- 复用到的既有结论:
  - `exp_meta` 标记表做迁移幂等判据(本次没加表/列,未触发)
  - Aiven 连接数上限低 → 批量保存复用同一个连接跑单事务,不在循环里各拿各的连接
  - `dateStrings: true` → DATE 以 `YYYY-MM-DD` 字符串回来;DECIMAL 以字符串回来(查重键用 `Number(x).toFixed(2)` 归一)

## 问题与解决方案

### ISSUE-001:验证时打 3111 端口全部 404「Not found」

- 日期:2026-07-31
- 环境:macOS,本机 dev
- 错误信息:`HTTP/1.1 404 Not Found` + 纯文本 `Not found`
- 触发条件:按记忆里的「验证用隔离的 `npm run dev:verify`(3111)」去打 `http://127.0.0.1:3111/api/...`

**根本原因**

3111 现在被 `tools/live-tunnel/proxy.mjs`(面试副屏的公网隧道反代)占着,那个代理有路径白名单,
白名单外一律返回纯文本 404。返回体和 `middleware.ts` 公网模式的 404 长得一样,极易误判成「路由没注册」。
连带结论:`npm run dev:verify`(写死 `-p 3111`)现在会撞端口——Next 可能顺延到别的端口,
打 3111 打到的永远是隧道代理,不是你要验的那个实例。

**失败的尝试**

1. 直接 curl 3111 —— 404,一度以为是新路由没被 Next 编译出来。
2. 想当然认为 3111 = dev:verify —— `ps` 一看是 `node tools/live-tunnel/proxy.mjs`。

**最终解决方案**

用用户已经在跑的 3100 验证(`next dev -p 3100`,dev 会按需编译新路由,不用重启)。
要另起隔离实例时,别用 3111,换个空闲端口并保留独立的 `NEXT_DIST_DIR`(不能和 3100 共用 `.next`)。

**验证方式**

`lsof -nP -iTCP -sTCP:LISTEN | grep 3111` → 看到的是 `proxy.mjs` 而不是 next-server。

### ISSUE-002:验证中途整站 500,报的却是别人的文件

- 日期:2026-07-31
- 错误信息:`ModuleBuildError … app/job-hunter/interview/cram/page.tsx:1614 Expected '</', got '}'`
- 触发条件:验证过程中另一个会话正在编辑 `cram/page.tsx`,存了一个语法不完整的中间态

**根本原因**

Next dev 一旦有 entry 编译失败,会把错误覆盖层丢给当前请求的页面,**即使这个页面根本不 import 那个文件**。
表现是「我的页面挂了」,实际和本功能无关。

**最终解决方案**

不改别人的文件,等对方存成完整语法后自动恢复(约 20 秒后 `/business-expense` 就回到 200)。
判据:看 500 页面 JSON 里的 `err.message` 指向哪个文件——指向别的功能就是别人的编译错误。

### ISSUE-003:Browser 面板 `screenshot` 出来是一整片灰

- 日期:2026-07-31
- 触发条件:用 `mcp__Claude_Browser__computer{action:"screenshot"}` 截 `/business-expense`

**根本原因**

该标签页 `document.visibilityState === "hidden"`(面板没真正显示),截出来只有灰底。
`tabs_select` 置前也没用。DOM 层面(`read_page` / `javascript_tool` 读 `.value`)是正常的。

**最终解决方案**

要出图就用本机 Chrome + puppeteer-core 自己截(`page.$('input[type=file]').uploadFile(...)` 能直接喂文件,
不用把测试图放进 `public/`)。功能正确性照旧用 DOM 断言,不依赖截图。

**后续注意**

`innerText` 读不到 `<input>` 的值(输入框的值是 DOM 属性不是文本)。
用 innerText dump 复核表会看到「一行空的」,那是错觉,必须读 `.value`。
另外前端 `addFiles` 里有 `inputRef.current.value = ""`(允许重复选同一个文件),
所以注入文件并派发 change 之后,`input.files[0]` 会是 undefined —— 要断言就看渲染出来的文件列表。

## 测试用例

### TC-001:账单截图 → 识别多笔(核心成功路径)

- 测试目标:图片链路能把一屏流水抽成多行,金额转正、类型正确、缺年份的日期能补
- 前置条件:dev server 3100 在跑;`OPENAI_API_KEY` 已配
- 输入数据:`statement.png`(仿用户截图:4 笔 `–$x` 刷卡消费 + 1 笔 `+$1,250.00` 存入,日期只有 `07/27` 这种)
- 操作步骤:`curl -F files=@statement.png -F today=2026-07-31 …/parse-batch`
- 预期结果:5 行;4 行 expense + 1 行 income;金额全为正;`07/27` → `2026-07-27`;
  vendor 清洗成 `County Market` / `Wal-Mart`;note 保留原始摘要
- 实际结果:完全符合(耗时 ~11s)
- 状态:PASS
- 自动化位置:手动(`curl`,依赖真实模型调用)
- 最后验证:2026-07-31

### TC-002:CSV 流水 → 识别多笔,且不把表头/合计当交易

- 输入数据:4 行 CSV(3 笔交易 + 1 行 `Total`,另有 `Balance` 列)
- 预期结果:只出 3 行;`Total` 行与 Balance 列不出现;Debit → expense、Credit → income
- 实际结果:3 行,类别给到「办公用品 / 软件订阅 / 服务收入」
- 状态:PASS ·  最后验证:2026-07-31

### TC-003:多文件一起识别(PDF + CSV)

- 输入数据:`statement.pdf`(5 笔,含 `TOTALS` 行,Debit/Credit 双列)+ `txns.csv`(3 笔)
- 预期结果:`files` 逐份报数([pdf:5, csv:3]);共 8 行;`TOTALS` 不入行;每行带来源文件名
- 实际结果:符合;两份并发 ~3.4s
- 状态:PASS ·  最后验证:2026-07-31

### TC-004:批量落库 + 读回

- 操作步骤:建临时 business「ZZ 批量导入自测」→ `save-batch` 3 笔(2 支 1 收)→ `list?businessId=`
- 预期结果:`savedCount=3`;summary = 收入 850 / 支出 65.31 / 净额 784.69 / 3 笔
- 实际结果:一致
- 状态:PASS ·  最后验证:2026-07-31

### TC-005:重复导入会被标出来(端到端,含 DECIMAL 归一)

- 前置条件:TC-004 的 3 笔已入库
- 操作步骤:拿同一份 CSV 再调 `parse-batch`,带上同一个 `businessId`
- 预期结果:3 行全部 `duplicate=true`(说明库里 DECIMAL 取回来的金额与前端字符串能归一到同一个键)
- 实际结果:全部 true
- 状态:PASS ·  最后验证:2026-07-31

### TC-006:界面全流程(上传 → 复核 → 部分勾选 → 入账)

- 操作步骤:
  1. `/business-expense` → 点「📥 批量导入」
  2. 选 business「ZZ 批量导入自测」,喂入 `statement.png`,点「识别多笔」
  3. 取消勾选第 5 行(那笔 1250 的收入)
  4. 批量改选中行的类别为「超市采购B」→ 点「填类别」
  5. 点「记入选中的 4 笔」
- 预期结果:
  - 表里 5 行,默认全勾;取消后统计变成「已选 4 笔 · 支出 $57.26」,按钮文案跟着变
  - 「填类别」只改勾选的 4 行,第 5 行仍是「其他」
  - 保存后已存的 4 行从表里消失,未勾的那行留着且值不变;明细总数 21 → 25
  - 库里 4 行的类别都是「超市采购B」,那笔 1250 的收入**没有**入库
- 实际结果:全部一致
- 状态:PASS ·  最后验证:2026-07-31
- 自动化位置:手动(浏览器 DOM 断言)

### TC-007:主要失败路径(不需要模型)

| # | 输入 | 预期 | 实际 |
|---|---|---|---|
| 1 | parse-batch 不传文件 | 400「请先选择要识别的文件。」 | 一致 |
| 2 | parse-batch 传 `.docx` | 400「…类型不支持(仅 PDF / 图片 / CSV / TXT)。」 | 一致 |
| 3 | parse-batch 传空文件 | 400「…是空文件,请重新选择。」 | 一致 |
| 4 | parse-batch 传 11 个文件 | 400「一次最多识别 10 个文件。」 | 一致 |
| 5 | save-batch `rows: []` | 400「没有要保存的记录。」 | 一致 |
| 6 | save-batch 缺 businessId | 400「请选择所属 business。」 | 一致 |
| 7 | save-batch 第 2 笔缺类别 | 400「第 2 笔:请填写类别。」 | 一致 |
| 8 | save-batch business 不存在 | 400「所选 business 不存在,请重新选择。」 | 一致 |
| 9 | save-batch 非 JSON body | 400「请求格式有误。」 | 一致 |

- 状态:PASS ·  最后验证:2026-07-31

### TC-008:纯逻辑单测

- 自动化位置:`web/lib/expense/batch.test.ts`(15 例)
- 覆盖:扩展名分流、`{rows:[]}`/裸数组两种形状、`−$7.48`/`(22.04)`/`$1,250.00` 的清洗、
  丢掉无金额的行、非法日期留空、字段截断与行数上限、`dupKey` 归一、库内重复 + 批内重复、
  `markDuplicates` 不改入参、合计遇到坏金额不变 NaN
- 状态:PASS(`npx vitest run lib/expense/batch.test.ts`)
- 最后验证:2026-07-31

### 回归:既有用例

- `npx vitest run` 全量 41 个文件 / 582 例通过(含本功能新增的 15 例)
- `npx tsc --noEmit`、`next lint` 均干净
- 最后验证:2026-07-31

## 测试数据清理

验证用的临时 business「ZZ 批量导入自测」与其名下 7 笔记录**已全部删除**,
`public/__test_statement.png` 也已删除;账本恢复为验证前的 3 个 business / 18 笔。

## 回归测试

- [x] TC-001 账单截图识别
- [x] TC-002 CSV 识别(排除表头/合计)
- [x] TC-003 多文件并发
- [x] TC-004 批量落库
- [x] TC-005 重复检测(端到端)
- [x] TC-006 界面全流程
- [x] TC-007 失败路径 9 项
- [x] TC-008 纯逻辑单测

## 未解决问题

- **识别质量依赖模型**:付款方式这类弱信号会猜(如 `MOBILE DEPOSIT` 猜成「支票」);
  这是复核表存在的理由,不当 bug 修。
- **超大对账单**:PDF 文本只取前 60,000 字符,超出部分静默丢弃(界面只在**行数**超 200 时提示)。
  几十页的年度对账单可能被截,建议按月导出。
- **没有「导入历史/撤销」**:批量入账后若发现整批都错,只能在明细里一条条删。
- **批量入账不带凭证文件**(有意决策,见上)。

## 后续优化

- 若「误判重复」变多,可把去重键放宽为可选「日期+金额+对方前若干字」并给开关。
- 可考虑记录一次导入的批次号,支持「撤销这一批」。
- Excel(.xlsx)流水目前不支持,需要的话可复用 exceljs 转成文本后走同一条链路。

## 更新日志

### 2026-07-31

- 完成:批量导入(识别多笔 → 复核 → 一次入账)整条链路,含重复提示与批量改字段
- 新增测试:`lib/expense/batch.test.ts` 15 例 + 手动端到端 TC-001~TC-007
- 变更原因:用户反馈「以前只能一步步操作」,一份银行流水要开几十次表单
