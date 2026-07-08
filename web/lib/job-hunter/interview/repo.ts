import type { RowDataPacket, ResultSetHeader } from "mysql2";

import { getPool } from "@/lib/serviceFee/db";

import type { Grade, QuestionType } from "./schema";

/**
 * 面试训练的持久化层。复用收费计算器的同一个 MySQL 连接池(getPool),
 * 表统一加 ip_ 前缀,建在同一 defaultdb 里;ensureInterviewSchema 幂等建表。
 */

let schemaReady: Promise<void> | null = null;

/** 执行 DDL,忽略「目标已是期望状态」的错误码(列/键已存在),让迁移可安全重跑。 */
async function execIgnoring(sql: string, ignoreCodes: string[]): Promise<void> {
  const p = getPool();
  try {
    await p.query(sql);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (!code || !ignoreCodes.includes(code)) throw err;
  }
}

/**
 * 迁移完成标记(记在 ip_meta)。不依赖 information_schema——
 * 该实例上 information_schema 在 DDL 后可能短暂滞后,不可作幂等判据。
 */
async function migrationDone(key: string): Promise<boolean> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>("SELECT 1 FROM ip_meta WHERE k = ? LIMIT 1", [key]);
  return rows.length > 0;
}
async function markMigrationDone(key: string): Promise<void> {
  const p = getPool();
  await p.query("INSERT IGNORE INTO ip_meta (k, v) VALUES (?, '1')", [key]);
}

export function ensureInterviewSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_meta (
        k VARCHAR(64) PRIMARY KEY,
        v VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_session (
        id INT AUTO_INCREMENT PRIMARY KEY,
        language VARCHAR(50) NOT NULL DEFAULT 'English',
        jd_text MEDIUMTEXT NOT NULL,
        resume_text MEDIUMTEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_skill (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL DEFAULT 'General',
        importance TINYINT NOT NULL DEFAULT 3,
        mastery DECIMAL(5,2) NOT NULL DEFAULT 0,
        attempts INT NOT NULL DEFAULT 0,
        last_practiced_at DATETIME NULL,
        UNIQUE KEY uniq_skill (session_id, name),
        CONSTRAINT fk_ip_skill_session FOREIGN KEY (session_id) REFERENCES ip_session(id) ON DELETE CASCADE
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_question (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        skill_id INT NOT NULL,
        type VARCHAR(40) NOT NULL,
        prompt MEDIUMTEXT NOT NULL,
        reference_answer MEDIUMTEXT NOT NULL,
        rubric_json JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_ip_q_session FOREIGN KEY (session_id) REFERENCES ip_session(id) ON DELETE CASCADE,
        CONSTRAINT fk_ip_q_skill FOREIGN KEY (skill_id) REFERENCES ip_skill(id) ON DELETE CASCADE
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_answer (
        id INT AUTO_INCREMENT PRIMARY KEY,
        question_id INT NOT NULL,
        skill_id INT NOT NULL,
        user_text MEDIUMTEXT NOT NULL,
        total_score TINYINT NOT NULL,
        score_json JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_ip_a_question FOREIGN KEY (question_id) REFERENCES ip_question(id) ON DELETE CASCADE,
        CONSTRAINT fk_ip_a_skill FOREIGN KEY (skill_id) REFERENCES ip_skill(id) ON DELETE CASCADE
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_kb_doc (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        char_count INT NOT NULL DEFAULT 0,
        chunk_count INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_kb_chunk (
        id INT AUTO_INCREMENT PRIMARY KEY,
        doc_id INT NOT NULL,
        ord INT NOT NULL,
        text MEDIUMTEXT NOT NULL,
        embedding JSON NOT NULL,
        CONSTRAINT fk_ip_chunk_doc FOREIGN KEY (doc_id) REFERENCES ip_kb_doc(id) ON DELETE CASCADE
      )
    `);

    // ---- 迁移 ip_bank_v1:题库绑定简历 + 每题间隔重复(遗忘曲线)所需的列 ----
    // 整块由标记守卫,只跑一次;每条 ALTER 又用 execIgnoring 容忍「已存在」,可安全重跑(自愈)。
    if (!(await migrationDone("ip_bank_v1"))) {
      // ip_session:题库模式标识 + 简历指纹(用于把题库绑定到具体简历) + 展示标题
      await execIgnoring(
        "ALTER TABLE ip_session ADD COLUMN mode VARCHAR(16) NOT NULL DEFAULT 'training'",
        ["ER_DUP_FIELDNAME"],
      );
      await execIgnoring(
        "ALTER TABLE ip_session ADD COLUMN resume_hash CHAR(64) NULL",
        ["ER_DUP_FIELDNAME"],
      );
      await execIgnoring(
        "ALTER TABLE ip_session ADD COLUMN title VARCHAR(255) NOT NULL DEFAULT ''",
        ["ER_DUP_FIELDNAME"],
      );
      // 简历指纹唯一(NULL 可重复,不影响训练会话);命中即复用同一题库。
      await execIgnoring(
        "ALTER TABLE ip_session ADD UNIQUE KEY uniq_resume_hash (resume_hash)",
        ["ER_DUP_KEYNAME"],
      );

      // ip_question:SM-2 间隔重复状态
      await execIgnoring(
        "ALTER TABLE ip_question ADD COLUMN ease_factor DECIMAL(4,2) NOT NULL DEFAULT 2.50",
        ["ER_DUP_FIELDNAME"],
      );
      await execIgnoring(
        "ALTER TABLE ip_question ADD COLUMN interval_days INT NOT NULL DEFAULT 0",
        ["ER_DUP_FIELDNAME"],
      );
      await execIgnoring(
        "ALTER TABLE ip_question ADD COLUMN repetitions INT NOT NULL DEFAULT 0",
        ["ER_DUP_FIELDNAME"],
      );
      await execIgnoring(
        "ALTER TABLE ip_question ADD COLUMN lapses INT NOT NULL DEFAULT 0",
        ["ER_DUP_FIELDNAME"],
      );
      await execIgnoring(
        "ALTER TABLE ip_question ADD COLUMN due_at DATETIME NULL",
        ["ER_DUP_FIELDNAME"],
      );
      await execIgnoring(
        "ALTER TABLE ip_question ADD COLUMN last_reviewed_at DATETIME NULL",
        ["ER_DUP_FIELDNAME"],
      );
      await execIgnoring(
        "ALTER TABLE ip_question ADD COLUMN last_score TINYINT NULL",
        ["ER_DUP_FIELDNAME"],
      );
      await execIgnoring(
        "ALTER TABLE ip_question ADD INDEX idx_ip_q_due (session_id, due_at)",
        ["ER_DUP_KEYNAME"],
      );

      await markMigrationDone("ip_bank_v1");
    }
  })().catch((err) => {
    // 建表/迁移失败别把「已拒绝的 promise」永久缓存,否则本进程后续所有调用都直接失败,
    // 直到重启才恢复。清空后下次调用可重试(对齐 expense/repo 的做法)。
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

function asJson<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

/* ---------------- session ---------------- */

export type SessionRow = {
  id: number;
  language: string;
  jd_text: string;
  resume_text: string;
  mode: string;
  title: string;
  resume_hash: string | null;
};

export async function createSession(
  language: string,
  jdText: string,
  resumeText: string,
): Promise<number> {
  await ensureInterviewSchema();
  const p = getPool();
  const [res] = await p.execute<ResultSetHeader>(
    "INSERT INTO ip_session (language, jd_text, resume_text) VALUES (?, ?, ?)",
    [language, jdText, resumeText],
  );
  return res.insertId;
}

/** 题库会话:绑定简历指纹,便于「同一份简历命中同一题库」。 */
export async function createBankSession(args: {
  language: string;
  jdText: string;
  resumeText: string;
  resumeHash: string;
  title: string;
}): Promise<number> {
  await ensureInterviewSchema();
  const p = getPool();
  const [res] = await p.execute<ResultSetHeader>(
    "INSERT INTO ip_session (language, jd_text, resume_text, mode, resume_hash, title) VALUES (?, ?, ?, 'bank', ?, ?)",
    [args.language, args.jdText, args.resumeText, args.resumeHash, args.title],
  );
  return res.insertId;
}

/** 按简历指纹找已存在的题库会话(用于幂等:同一简历不重复建库)。 */
export async function findBankSessionByHash(resumeHash: string): Promise<SessionRow | null> {
  await ensureInterviewSchema();
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id, language, jd_text, resume_text, mode, resume_hash, title FROM ip_session WHERE resume_hash = ? LIMIT 1",
    [resumeHash],
  );
  return (rows[0] as SessionRow) ?? null;
}

/** 删除会话(级联删除其技能/题目/作答)。用于「重新生成题库」覆盖旧库。 */
export async function deleteSession(id: number): Promise<void> {
  const p = getPool();
  await p.execute("DELETE FROM ip_session WHERE id = ?", [id]);
}

export async function getSession(id: number): Promise<SessionRow | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id, language, jd_text, resume_text, mode, resume_hash, title FROM ip_session WHERE id = ?",
    [id],
  );
  return (rows[0] as SessionRow) ?? null;
}

/* ---------------- skills ---------------- */

export type SkillRow = {
  id: number;
  session_id: number;
  name: string;
  category: string;
  importance: number;
  mastery: number;
  attempts: number;
  last_practiced_at: string | null;
};

export async function insertSkills(
  sessionId: number,
  skills: Array<{ name: string; category: string; importance: number }>,
): Promise<void> {
  if (!skills.length) return;
  const p = getPool();
  const values = skills.map((s) => [sessionId, s.name, s.category, s.importance]);
  await p.query(
    "INSERT IGNORE INTO ip_skill (session_id, name, category, importance) VALUES ?",
    [values],
  );
}

export async function getSkills(sessionId: number): Promise<SkillRow[]> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id, session_id, name, category, importance, mastery, attempts, last_practiced_at FROM ip_skill WHERE session_id = ? ORDER BY importance DESC, id ASC",
    [sessionId],
  );
  return (rows as SkillRow[]).map((r) => ({ ...r, mastery: Number(r.mastery) }));
}

/** 技能名(小写) → id 映射,供题库把每题挂到对应技能上。 */
export async function getSkillIdMap(sessionId: number): Promise<Map<string, number>> {
  const rows = await getSkills(sessionId);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.name.toLowerCase(), r.id);
  return map;
}

export async function getSkill(skillId: number): Promise<SkillRow | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id, session_id, name, category, importance, mastery, attempts, last_practiced_at FROM ip_skill WHERE id = ?",
    [skillId],
  );
  const r = rows[0] as SkillRow | undefined;
  return r ? { ...r, mastery: Number(r.mastery) } : null;
}

export async function updateSkillMastery(
  skillId: number,
  mastery: number,
  attempts: number,
): Promise<void> {
  const p = getPool();
  await p.execute(
    "UPDATE ip_skill SET mastery = ?, attempts = ?, last_practiced_at = NOW() WHERE id = ?",
    [mastery, attempts, skillId],
  );
}

/* ---------------- questions ---------------- */

export async function insertQuestion(args: {
  sessionId: number;
  skillId: number;
  type: QuestionType;
  prompt: string;
  referenceAnswer: string;
  rubric: Array<{ criterion: string; weight: number }>;
}): Promise<number> {
  const p = getPool();
  const [res] = await p.execute<ResultSetHeader>(
    "INSERT INTO ip_question (session_id, skill_id, type, prompt, reference_answer, rubric_json) VALUES (?, ?, ?, ?, ?, ?)",
    [
      args.sessionId,
      args.skillId,
      args.type,
      args.prompt,
      args.referenceAnswer,
      JSON.stringify(args.rubric),
    ],
  );
  return res.insertId;
}

export type QuestionRow = {
  id: number;
  session_id: number;
  skill_id: number;
  type: QuestionType;
  prompt: string;
  reference_answer: string;
  rubric: Array<{ criterion: string; weight: number }>;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  lapses: number;
};

export async function getQuestion(id: number): Promise<QuestionRow | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id, session_id, skill_id, type, prompt, reference_answer, rubric_json, ease_factor, interval_days, repetitions, lapses FROM ip_question WHERE id = ?",
    [id],
  );
  const r = rows[0] as (RowDataPacket & { rubric_json: unknown }) | undefined;
  if (!r) return null;
  return {
    id: r.id,
    session_id: r.session_id,
    skill_id: r.skill_id,
    type: r.type,
    prompt: r.prompt,
    reference_answer: r.reference_answer,
    rubric: asJson(r.rubric_json),
    ease_factor: Number(r.ease_factor),
    interval_days: Number(r.interval_days),
    repetitions: Number(r.repetitions),
    lapses: Number(r.lapses),
  };
}

/** 最近出过的题干(避免重复) */
export async function getAskedPrompts(sessionId: number, limit = 30): Promise<string[]> {
  const p = getPool();
  // 用 query 而非 execute:预处理语句对 LIMIT 占位符支持不稳(mysql2 已知坑)
  const [rows] = await p.query<RowDataPacket[]>(
    "SELECT prompt FROM ip_question WHERE session_id = ? ORDER BY id DESC LIMIT ?",
    [sessionId, limit],
  );
  return rows.map((r) => r.prompt as string);
}

/* ---------------- question bank + 间隔重复 ---------------- */

export type BankInsertItem = {
  skillId: number;
  type: QuestionType;
  prompt: string;
  referenceAnswer: string;
  rubric: Array<{ criterion: string; weight: number }>;
};

/** 批量写入题库题目;due_at = NOW() 让它们即刻可复习,repetitions=0 记为「新题」。 */
export async function insertBankQuestions(
  sessionId: number,
  items: BankInsertItem[],
): Promise<number> {
  if (!items.length) return 0;
  const p = getPool();
  const values = items.map((q) => [
    sessionId,
    q.skillId,
    q.type,
    q.prompt,
    q.referenceAnswer,
    JSON.stringify(q.rubric),
  ]);
  const [res] = await p.query<ResultSetHeader>(
    "INSERT INTO ip_question (session_id, skill_id, type, prompt, reference_answer, rubric_json, due_at) VALUES " +
      values.map(() => "(?, ?, ?, ?, ?, ?, NOW())").join(", "),
    values.flat(),
  );
  return res.affectedRows ?? items.length;
}

export async function countQuestions(sessionId: number): Promise<number> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM ip_question WHERE session_id = ?",
    [sessionId],
  );
  return Number(rows[0]?.n ?? 0);
}

export type NextCardRow = {
  id: number;
  skill_id: number;
  skill: string;
  category: string;
  type: QuestionType;
  prompt: string;
  interval_days: number;
  last_reviewed_at: string | null;
};

/**
 * 取下一张要复习的卡:优先已到期的复习题(复习过 且 due_at<=NOW(),先到期先复习),
 * 其次未练过的新题(last_reviewed_at 为空),都没有则返回 null(今日已清空)。
 * 注意:用 last_reviewed_at 判断新题——答砸后 SM-2 会把 repetitions 归零,
 * 若按 repetitions=0 判断,重学中的失败卡会被误当新题、无视 due_at 立刻重现。
 */
export async function getNextCard(sessionId: number): Promise<NextCardRow | null> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT q.id, q.skill_id, s.name AS skill, s.category, q.type, q.prompt,
            q.interval_days, q.last_reviewed_at
       FROM ip_question q
       JOIN ip_skill s ON s.id = q.skill_id
      WHERE q.session_id = ?
        AND (q.last_reviewed_at IS NULL OR q.due_at IS NULL OR q.due_at <= NOW())
      ORDER BY (q.last_reviewed_at IS NOT NULL AND q.due_at IS NOT NULL AND q.due_at <= NOW()) DESC,
               q.due_at ASC, q.id ASC
      LIMIT 1`,
    [sessionId],
  );
  const r = rows[0] as NextCardRow | undefined;
  if (!r) return null;
  return { ...r, interval_days: Number(r.interval_days) };
}

export type BankItemRow = {
  id: number;
  skill: string;
  category: string;
  type: QuestionType;
  prompt: string;
  repetitions: number;
  interval_days: number;
  lapses: number;
  last_score: number | null;
  due_at: string | null;
  last_reviewed_at: string | null;
  is_due: number; // 1 = 已到期/可复习
};

/** 题库全量列表(含每题的间隔重复状态),给题库面板展示。 */
export async function getBankList(sessionId: number): Promise<BankItemRow[]> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT q.id, s.name AS skill, s.category, q.type, q.prompt,
            q.repetitions, q.interval_days, q.lapses, q.last_score,
            q.due_at, q.last_reviewed_at,
            (q.last_reviewed_at IS NULL OR q.due_at IS NULL OR q.due_at <= NOW()) AS is_due
       FROM ip_question q
       JOIN ip_skill s ON s.id = q.skill_id
      WHERE q.session_id = ?
      ORDER BY q.id ASC`,
    [sessionId],
  );
  return (rows as BankItemRow[]).map((r) => ({
    ...r,
    repetitions: Number(r.repetitions),
    interval_days: Number(r.interval_days),
    lapses: Number(r.lapses),
    last_score: r.last_score == null ? null : Number(r.last_score),
    is_due: Number(r.is_due),
  }));
}

export type SrCounts = {
  total: number;
  fresh: number; // 新题(未练过)
  due: number; // 已到期待复习
  later: number; // 已排期、尚未到期
  mastered: number; // interval >= 21 天
};

/** 复习面板的汇总计数。 */
export async function getSrCounts(sessionId: number): Promise<SrCounts> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    // 用 last_reviewed_at 判断新题/复习题:答砸后 repetitions 归零,不能拿它当「新题」判据。
    // fresh | due | later 三者互斥且完备;mastered 是「复习过且间隔≥21天」的叠加视图。
    `SELECT
        COUNT(*) AS total,
        SUM(last_reviewed_at IS NULL) AS fresh,
        SUM(last_reviewed_at IS NOT NULL AND due_at IS NOT NULL AND due_at <= NOW()) AS due,
        SUM(last_reviewed_at IS NOT NULL AND due_at IS NOT NULL AND due_at > NOW()) AS later,
        SUM(last_reviewed_at IS NOT NULL AND interval_days >= 21) AS mastered
       FROM ip_question WHERE session_id = ?`,
    [sessionId],
  );
  const r = rows[0] ?? {};
  return {
    total: Number(r.total ?? 0),
    fresh: Number(r.fresh ?? 0),
    due: Number(r.due ?? 0),
    later: Number(r.later ?? 0),
    mastered: Number(r.mastered ?? 0),
  };
}

/** 作答后更新该题的 SM-2 状态,并按新间隔把 due_at 顺延(SQL 侧 DATE_ADD,避免时区漂移)。 */
export async function updateQuestionSr(
  questionId: number,
  update: { ease_factor: number; interval_days: number; repetitions: number; lapses: number },
  lastScore: number,
): Promise<void> {
  const p = getPool();
  await p.execute(
    `UPDATE ip_question
        SET ease_factor = ?, interval_days = ?, repetitions = ?, lapses = ?,
            last_score = ?, last_reviewed_at = NOW(),
            due_at = DATE_ADD(NOW(), INTERVAL ? DAY)
      WHERE id = ?`,
    [
      update.ease_factor,
      update.interval_days,
      update.repetitions,
      update.lapses,
      lastScore,
      update.interval_days,
      questionId,
    ],
  );
}

/* ---------------- answers ---------------- */

export async function insertAnswer(args: {
  questionId: number;
  skillId: number;
  userText: string;
  total: number;
  grade: Grade;
}): Promise<number> {
  const p = getPool();
  const [res] = await p.execute<ResultSetHeader>(
    "INSERT INTO ip_answer (question_id, skill_id, user_text, total_score, score_json) VALUES (?, ?, ?, ?, ?)",
    [args.questionId, args.skillId, args.userText, args.total, JSON.stringify(args.grade)],
  );
  return res.insertId;
}

/** 某技能最近的弱点(misses + errors),用于补强 */
export async function getSkillWeaknesses(skillId: number, limit = 5): Promise<string[]> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    "SELECT score_json FROM ip_answer WHERE skill_id = ? ORDER BY id DESC LIMIT ?",
    [skillId, limit],
  );
  // 兼容两种历史形态:旧数据是 string[],新数据是 {zh,en}[]。取中文(缺则英文)。
  const pull = (arr: unknown): string[] =>
    (Array.isArray(arr) ? arr : [])
      .map((x) =>
        typeof x === "string" ? x : (x as { zh?: string; en?: string })?.zh || (x as { en?: string })?.en || "",
      )
      .filter(Boolean);
  const out: string[] = [];
  for (const r of rows) {
    const g = asJson<Grade>(r.score_json);
    out.push(...pull(g.misses), ...pull(g.errors));
  }
  return Array.from(new Set(out)).slice(0, 12);
}

export type AnswerSummary = {
  id: number;
  skill: string;
  type: QuestionType;
  prompt: string;
  total: number;
  created_at: string;
};

export async function getRecentAnswers(sessionId: number, limit = 20): Promise<AnswerSummary[]> {
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT a.id, s.name AS skill, q.type, q.prompt, a.total_score AS total, a.created_at
     FROM ip_answer a
     JOIN ip_question q ON q.id = a.question_id
     JOIN ip_skill s ON s.id = a.skill_id
     WHERE q.session_id = ?
     ORDER BY a.id DESC LIMIT ?`,
    [sessionId, limit],
  );
  return rows as AnswerSummary[];
}

/* ---------------- knowledge base ---------------- */

export async function insertKbDoc(
  title: string,
  charCount: number,
  chunks: Array<{ text: string; embedding: number[] }>,
): Promise<number> {
  await ensureInterviewSchema();
  const p = getPool();
  const [res] = await p.execute<ResultSetHeader>(
    "INSERT INTO ip_kb_doc (title, char_count, chunk_count) VALUES (?, ?, ?)",
    [title, charCount, chunks.length],
  );
  const docId = res.insertId;
  if (chunks.length) {
    const values = chunks.map((c, i) => [docId, i, c.text, JSON.stringify(c.embedding)]);
    await p.query("INSERT INTO ip_kb_chunk (doc_id, ord, text, embedding) VALUES ?", [values]);
  }
  return docId;
}

export type KbDocRow = {
  id: number;
  title: string;
  char_count: number;
  chunk_count: number;
  created_at: string;
};

export async function listKbDocs(): Promise<KbDocRow[]> {
  await ensureInterviewSchema();
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id, title, char_count, chunk_count, created_at FROM ip_kb_doc ORDER BY id DESC",
  );
  return rows as KbDocRow[];
}

export async function deleteKbDoc(id: number): Promise<void> {
  const p = getPool();
  await p.execute("DELETE FROM ip_kb_doc WHERE id = ?", [id]);
}

type ChunkRow = { id: number; text: string; embedding: unknown };

function cosine(a: number[], b: number[]): number {
  // 维度不一致(例如换了不同维度的 embedding 模型却没重建索引)直接判 0,
  // 避免只比对前缀得出“看似合理实则无意义”的相似度。
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 基于查询向量,在全部知识库分块里取 top-k 文本(小规模:全量加载 + Node 端 cosine)。 */
export async function retrieveKbChunks(queryEmbedding: number[], k = 5): Promise<string[]> {
  if (!queryEmbedding.length) return [];
  await ensureInterviewSchema();
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id, text, embedding FROM ip_kb_chunk",
  );
  const scored = (rows as ChunkRow[]).map((r) => ({
    text: r.text,
    score: cosine(queryEmbedding, asJson<number[]>(r.embedding)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.text);
}

export async function hasKb(): Promise<boolean> {
  await ensureInterviewSchema();
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>("SELECT 1 FROM ip_kb_chunk LIMIT 1");
  return rows.length > 0;
}
