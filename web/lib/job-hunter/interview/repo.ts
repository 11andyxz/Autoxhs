import type { RowDataPacket, ResultSetHeader } from "mysql2";

import { getPool } from "@/lib/serviceFee/db";

import type { Coach, ExplainExtras, Grade, QuestionType } from "./schema";

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
    // 单词本(全局,不绑定会话):划词加入的生词,含音标/释义/例句 + SM-2 间隔重复状态。
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_vocab (
        id INT AUTO_INCREMENT PRIMARY KEY,
        term VARCHAR(255) NOT NULL,
        term_norm VARCHAR(255) NOT NULL UNIQUE,
        en VARCHAR(255) NOT NULL DEFAULT '',
        ipa VARCHAR(255) NOT NULL DEFAULT '',
        zh VARCHAR(500) NOT NULL DEFAULT '',
        note VARCHAR(1000) NOT NULL DEFAULT '',
        example MEDIUMTEXT NOT NULL,
        example_zh VARCHAR(1000) NOT NULL DEFAULT '',
        demo MEDIUMTEXT NULL,
        demo_note VARCHAR(500) NOT NULL DEFAULT '',
        ease_factor DECIMAL(4,2) NOT NULL DEFAULT 2.50,
        interval_days INT NOT NULL DEFAULT 0,
        repetitions INT NOT NULL DEFAULT 0,
        lapses INT NOT NULL DEFAULT 0,
        due_at DATETIME NULL,
        last_reviewed_at DATETIME NULL,
        last_grade VARCHAR(10) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ip_vocab_due (due_at)
      )
    `);
    // 弱点补强内容(每个技能一份,持久化):生成后固定展示,除非手动重新生成。
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_coach (
        skill_id INT PRIMARY KEY,
        lesson MEDIUMTEXT NOT NULL,
        model_answer MEDIUMTEXT NOT NULL,
        practice_question MEDIUMTEXT NOT NULL,
        ease_factor DECIMAL(4,2) NOT NULL DEFAULT 2.50,
        interval_days INT NOT NULL DEFAULT 0,
        repetitions INT NOT NULL DEFAULT 0,
        lapses INT NOT NULL DEFAULT 0,
        due_at DATETIME NULL,
        last_reviewed_at DATETIME NULL,
        last_pct TINYINT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_ip_coach_skill FOREIGN KEY (skill_id) REFERENCES ip_skill(id) ON DELETE CASCADE
      )
    `);

    // 每道题的「讲解」(per-question,区别于 ip_coach 的 per-skill):点「不会」时按这道题
    // 单独生成、持久化,并带理解度%的遗忘曲线。这样同一技能下不同题目各有各的讲解。
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_explain (
        question_id INT PRIMARY KEY,
        lesson MEDIUMTEXT NOT NULL,
        model_answer MEDIUMTEXT NOT NULL,
        practice_question MEDIUMTEXT NOT NULL,
        keywords_json MEDIUMTEXT NULL,
        diagrams_json MEDIUMTEXT NULL,
        image_plan_json MEDIUMTEXT NULL,
        ease_factor DECIMAL(4,2) NOT NULL DEFAULT 2.50,
        interval_days INT NOT NULL DEFAULT 0,
        repetitions INT NOT NULL DEFAULT 0,
        lapses INT NOT NULL DEFAULT 0,
        due_at DATETIME NULL,
        last_reviewed_at DATETIME NULL,
        last_pct TINYINT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_ip_explain_q FOREIGN KEY (question_id) REFERENCES ip_question(id) ON DELETE CASCADE
      )
    `);

    // 讲解的「意象配图」(gpt-image 生成,base64 存库;每题 N 张,ord 区分)。异步生成、可持久化。
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_explain_image (
        question_id INT NOT NULL,
        ord INT NOT NULL,
        caption VARCHAR(500) NOT NULL DEFAULT '',
        b64 LONGTEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (question_id, ord),
        CONSTRAINT fk_ip_explain_img_q FOREIGN KEY (question_id) REFERENCES ip_question(id) ON DELETE CASCADE
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

    // ---- 迁移 ip_fundamentals_v1:题目来源标记(bank=简历题库,fundamentals=技术八股文)。
    // 便于「重新生成八股文」时只删八股文那批,不动原来的行为面试/技术题。
    if (!(await migrationDone("ip_fundamentals_v1"))) {
      await execIgnoring(
        "ALTER TABLE ip_question ADD COLUMN source VARCHAR(24) NOT NULL DEFAULT 'bank'",
        ["ER_DUP_FIELDNAME"],
      );
      await markMigrationDone("ip_fundamentals_v1");
    }

    // ---- 迁移 ip_vocab_en_v1:单词本存「英文读法」(en),让例句/发音都用英文而非选中的中文。
    if (!(await migrationDone("ip_vocab_en_v1"))) {
      await execIgnoring(
        "ALTER TABLE ip_vocab ADD COLUMN en VARCHAR(255) NOT NULL DEFAULT ''",
        ["ER_DUP_FIELDNAME"],
      );
      await markMigrationDone("ip_vocab_en_v1");
    }

    // ---- 迁移 ip_vocab_demo_v1:单词本每张卡再带一个「例子」(尽量是代码片段)demo + 中文说明。
    if (!(await migrationDone("ip_vocab_demo_v1"))) {
      await execIgnoring("ALTER TABLE ip_vocab ADD COLUMN demo MEDIUMTEXT NULL", ["ER_DUP_FIELDNAME"]);
      await execIgnoring(
        "ALTER TABLE ip_vocab ADD COLUMN demo_note VARCHAR(500) NOT NULL DEFAULT ''",
        ["ER_DUP_FIELDNAME"],
      );
      await markMigrationDone("ip_vocab_demo_v1");
    }

    // ---- 迁移 ip_explain_extras_v1:讲解附加料(关键词/SVG示意图/生图计划)所需的列 + 配图表。
    if (!(await migrationDone("ip_explain_extras_v1"))) {
      for (const col of [
        "ADD COLUMN keywords_json MEDIUMTEXT NULL",
        "ADD COLUMN diagrams_json MEDIUMTEXT NULL",
        "ADD COLUMN image_plan_json MEDIUMTEXT NULL",
      ]) {
        await execIgnoring(`ALTER TABLE ip_explain ${col}`, ["ER_DUP_FIELDNAME"]);
      }
      await p.query(`
        CREATE TABLE IF NOT EXISTS ip_explain_image (
          question_id INT NOT NULL,
          ord INT NOT NULL,
          caption VARCHAR(500) NOT NULL DEFAULT '',
          b64 LONGTEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (question_id, ord),
          CONSTRAINT fk_ip_explain_img_q FOREIGN KEY (question_id) REFERENCES ip_question(id) ON DELETE CASCADE
        )
      `);
      await markMigrationDone("ip_explain_extras_v1");
    }

    // ---- 迁移 ip_coach_sr_v1:讲解也纳入遗忘曲线(SM-2 + 理解度%)所需的列。
    if (!(await migrationDone("ip_coach_sr_v1"))) {
      for (const col of [
        "ADD COLUMN ease_factor DECIMAL(4,2) NOT NULL DEFAULT 2.50",
        "ADD COLUMN interval_days INT NOT NULL DEFAULT 0",
        "ADD COLUMN repetitions INT NOT NULL DEFAULT 0",
        "ADD COLUMN lapses INT NOT NULL DEFAULT 0",
        "ADD COLUMN due_at DATETIME NULL",
        "ADD COLUMN last_reviewed_at DATETIME NULL",
        "ADD COLUMN last_pct TINYINT NULL",
      ]) {
        await execIgnoring(`ALTER TABLE ip_coach ${col}`, ["ER_DUP_FIELDNAME"]);
      }
      await markMigrationDone("ip_coach_sr_v1");
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

export type BankSessionSummary = {
  id: number;
  title: string;
  language: string;
  created_at: string;
  total: number;
  due: number;
};

/** 所有题库会话(按人名/简历标题展示),带每个库的总题数与待复习数。给「面试复习」入口用。 */
export async function listBankSessions(): Promise<BankSessionSummary[]> {
  await ensureInterviewSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT s.id, s.title, s.language, s.created_at,
        COUNT(q.id) AS total,
        SUM(q.last_reviewed_at IS NULL OR (q.due_at IS NOT NULL AND q.due_at <= NOW())) AS due
       FROM ip_session s
       LEFT JOIN ip_question q ON q.session_id = s.id
      WHERE s.mode = 'bank'
      GROUP BY s.id, s.title, s.language, s.created_at
      ORDER BY s.created_at DESC`,
  );
  return (rows as RowDataPacket[]).map((r) => ({
    id: Number(r.id),
    title: (r.title as string) || "我的简历",
    language: r.language as string,
    created_at: r.created_at as string,
    total: Number(r.total ?? 0),
    due: Number(r.due ?? 0),
  }));
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

/** 批量写入题库题目;due_at = NOW() 让它们即刻可复习,repetitions=0 记为「新题」。source 区分来源。 */
export async function insertBankQuestions(
  sessionId: number,
  items: BankInsertItem[],
  source: "bank" | "fundamentals" = "bank",
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
    source,
  ]);
  const [res] = await p.query<ResultSetHeader>(
    "INSERT INTO ip_question (session_id, skill_id, type, prompt, reference_answer, rubric_json, source, due_at) VALUES " +
      values.map(() => "(?, ?, ?, ?, ?, ?, ?, NOW())").join(", "),
    values.flat(),
  );
  return res.affectedRows ?? items.length;
}

/** 该题库已有的技术八股文题目数(判断是否已生成)。 */
export async function countFundamentals(sessionId: number): Promise<number> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM ip_question WHERE session_id = ? AND source = 'fundamentals'",
    [sessionId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** 删除该题库的技术八股文题目(重新生成前清空,不动原来的题)。 */
export async function deleteFundamentals(sessionId: number): Promise<void> {
  const p = getPool();
  await p.execute("DELETE FROM ip_question WHERE session_id = ? AND source = 'fundamentals'", [sessionId]);
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
  skill_id: number;
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
  source: string;
  is_due: number; // 1 = 已到期/可复习
};

/** 题库全量列表(含每题的间隔重复状态),给题库面板展示。 */
export async function getBankList(sessionId: number): Promise<BankItemRow[]> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT q.id, q.skill_id, s.name AS skill, s.category, q.type, q.prompt,
            q.repetitions, q.interval_days, q.lapses, q.last_score,
            q.due_at, q.last_reviewed_at, q.source,
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

/* ---------------- 弱点补强(持久化,每技能一份) ---------------- */

export async function getCoach(skillId: number): Promise<Coach | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT lesson, model_answer, practice_question FROM ip_coach WHERE skill_id = ?",
    [skillId],
  );
  const r = rows[0] as
    | { lesson: string; model_answer: string; practice_question: string }
    | undefined;
  if (!r) return null;
  return { lesson: r.lesson, modelAnswer: r.model_answer, practiceQuestion: r.practice_question };
}

export async function saveCoach(skillId: number, c: Coach): Promise<void> {
  const p = getPool();
  await p.execute(
    `INSERT INTO ip_coach (skill_id, lesson, model_answer, practice_question)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE lesson = VALUES(lesson), model_answer = VALUES(model_answer),
       practice_question = VALUES(practice_question)`,
    [skillId, c.lesson, c.modelAnswer, c.practiceQuestion],
  );
}

/* ---------------- 讲解的间隔重复(理解度% → SM-2) ---------------- */

export type CoachSr = {
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  lapses: number;
  due_at: string | null;
  last_reviewed_at: string | null;
  last_pct: number | null;
};

export async function getCoachSr(skillId: number): Promise<CoachSr | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT ease_factor, interval_days, repetitions, lapses, due_at, last_reviewed_at, last_pct
       FROM ip_coach WHERE skill_id = ?`,
    [skillId],
  );
  const r = rows[0] as CoachSr | undefined;
  if (!r) return null;
  return {
    ease_factor: Number(r.ease_factor),
    interval_days: Number(r.interval_days),
    repetitions: Number(r.repetitions),
    lapses: Number(r.lapses),
    due_at: r.due_at,
    last_reviewed_at: r.last_reviewed_at,
    last_pct: r.last_pct == null ? null : Number(r.last_pct),
  };
}

/** 记录理解度 → 更新讲解的 SM-2 调度(SQL 侧 DATE_ADD)。 */
export async function rateCoach(
  skillId: number,
  update: { ease_factor: number; interval_days: number; repetitions: number; lapses: number },
  pct: number,
): Promise<void> {
  const p = getPool();
  await p.execute(
    `UPDATE ip_coach
        SET ease_factor = ?, interval_days = ?, repetitions = ?, lapses = ?,
            last_pct = ?, last_reviewed_at = NOW(),
            due_at = DATE_ADD(NOW(), INTERVAL ? DAY)
      WHERE skill_id = ?`,
    [update.ease_factor, update.interval_days, update.repetitions, update.lapses, pct, update.interval_days, skillId],
  );
}

export type CoachCardRow = {
  skill_id: number;
  skill: string;
  category: string;
  interval_days: number;
  last_pct: number | null;
  due_at: string | null;
  last_reviewed_at: string | null;
  is_due: number;
};

/** 某会话下已生成讲解的技能列表(带遗忘曲线状态),给「讲解复习」面板用。 */
export async function listCoachCards(sessionId: number): Promise<CoachCardRow[]> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT co.skill_id, s.name AS skill, s.category, co.interval_days, co.last_pct,
            co.due_at, co.last_reviewed_at,
            (co.last_reviewed_at IS NULL OR co.due_at IS NULL OR co.due_at <= NOW()) AS is_due
       FROM ip_coach co
       JOIN ip_skill s ON s.id = co.skill_id
      WHERE s.session_id = ?
      ORDER BY (co.last_reviewed_at IS NOT NULL AND co.due_at IS NOT NULL AND co.due_at <= NOW()) DESC,
               co.due_at ASC, co.skill_id ASC`,
    [sessionId],
  );
  return (rows as CoachCardRow[]).map((r) => ({
    ...r,
    interval_days: Number(r.interval_days),
    last_pct: r.last_pct == null ? null : Number(r.last_pct),
    is_due: Number(r.is_due),
  }));
}

/* ---------------- 每题讲解(per-question,点「不会」用) + 其遗忘曲线 ---------------- */

export async function getExplain(questionId: number): Promise<Coach | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT lesson, model_answer, practice_question FROM ip_explain WHERE question_id = ?",
    [questionId],
  );
  const r = rows[0] as
    | { lesson: string; model_answer: string; practice_question: string }
    | undefined;
  if (!r) return null;
  return { lesson: r.lesson, modelAnswer: r.model_answer, practiceQuestion: r.practice_question };
}

export async function saveExplain(questionId: number, c: Coach): Promise<void> {
  const p = getPool();
  await p.execute(
    `INSERT INTO ip_explain (question_id, lesson, model_answer, practice_question)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE lesson = VALUES(lesson), model_answer = VALUES(model_answer),
       practice_question = VALUES(practice_question)`,
    [questionId, c.lesson, c.modelAnswer, c.practiceQuestion],
  );
}

export async function getExplainSr(questionId: number): Promise<CoachSr | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT ease_factor, interval_days, repetitions, lapses, due_at, last_reviewed_at, last_pct
       FROM ip_explain WHERE question_id = ?`,
    [questionId],
  );
  const r = rows[0] as CoachSr | undefined;
  if (!r) return null;
  return {
    ease_factor: Number(r.ease_factor),
    interval_days: Number(r.interval_days),
    repetitions: Number(r.repetitions),
    lapses: Number(r.lapses),
    due_at: r.due_at,
    last_reviewed_at: r.last_reviewed_at,
    last_pct: r.last_pct == null ? null : Number(r.last_pct),
  };
}

/** 记录理解度 → 更新该题讲解的 SM-2 调度。 */
export async function rateExplain(
  questionId: number,
  update: { ease_factor: number; interval_days: number; repetitions: number; lapses: number },
  pct: number,
): Promise<void> {
  const p = getPool();
  await p.execute(
    `UPDATE ip_explain
        SET ease_factor = ?, interval_days = ?, repetitions = ?, lapses = ?,
            last_pct = ?, last_reviewed_at = NOW(),
            due_at = DATE_ADD(NOW(), INTERVAL ? DAY)
      WHERE question_id = ?`,
    [update.ease_factor, update.interval_days, update.repetitions, update.lapses, pct, update.interval_days, questionId],
  );
}

export type ExplainCardRow = {
  question_id: number;
  prompt: string;
  skill: string;
  category: string;
  type: QuestionType;
  interval_days: number;
  last_pct: number | null;
  due_at: string | null;
  last_reviewed_at: string | null;
  is_due: number;
};

/** 某会话下已生成讲解的题目列表(带遗忘曲线状态),给「讲解复习」面板用。 */
export async function listExplainCards(sessionId: number): Promise<ExplainCardRow[]> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT e.question_id, q.prompt, s.name AS skill, s.category, q.type,
            e.interval_days, e.last_pct, e.due_at, e.last_reviewed_at,
            (e.last_reviewed_at IS NULL OR e.due_at IS NULL OR e.due_at <= NOW()) AS is_due
       FROM ip_explain e
       JOIN ip_question q ON q.id = e.question_id
       JOIN ip_skill s ON s.id = q.skill_id
      WHERE q.session_id = ?
      ORDER BY (e.last_reviewed_at IS NOT NULL AND e.due_at IS NOT NULL AND e.due_at <= NOW()) DESC,
               e.due_at ASC, e.question_id ASC`,
    [sessionId],
  );
  return (rows as ExplainCardRow[]).map((r) => ({
    ...r,
    interval_days: Number(r.interval_days),
    last_pct: r.last_pct == null ? null : Number(r.last_pct),
    is_due: Number(r.is_due),
  }));
}

/* ---------------- 讲解附加料:关键词 + SVG 示意图 + 生图计划 + 配图 ---------------- */

/** 读取某题讲解的附加料;keywords_json 为空视为「还没生成」→ 返回 null。 */
export async function getExplainExtras(questionId: number): Promise<ExplainExtras | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT keywords_json, diagrams_json, image_plan_json FROM ip_explain WHERE question_id = ?",
    [questionId],
  );
  const r = rows[0] as
    | { keywords_json: string | null; diagrams_json: string | null; image_plan_json: string | null }
    | undefined;
  if (!r || r.keywords_json == null) return null;
  const parse = <T>(s: string | null): T[] => {
    if (!s) return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  };
  return {
    keywords: parse(r.keywords_json),
    diagrams: parse(r.diagrams_json),
    imagePlan: parse(r.image_plan_json),
  };
}

export async function saveExplainExtras(questionId: number, extras: ExplainExtras): Promise<void> {
  const p = getPool();
  await p.execute(
    "UPDATE ip_explain SET keywords_json = ?, diagrams_json = ?, image_plan_json = ? WHERE question_id = ?",
    [
      JSON.stringify(extras.keywords).slice(0, 16_000_000),
      JSON.stringify(extras.diagrams).slice(0, 16_000_000),
      JSON.stringify(extras.imagePlan).slice(0, 16_000_000),
      questionId,
    ],
  );
}

/** 重新生成讲解时,连附加料 + 已生成的配图一起清掉(下次自动重生)。 */
export async function clearExplainExtras(questionId: number): Promise<void> {
  const p = getPool();
  await p.execute(
    "UPDATE ip_explain SET keywords_json = NULL, diagrams_json = NULL, image_plan_json = NULL WHERE question_id = ?",
    [questionId],
  );
  await p.execute("DELETE FROM ip_explain_image WHERE question_id = ?", [questionId]);
}

export async function getExplainImageB64(questionId: number, ord: number): Promise<string | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT b64 FROM ip_explain_image WHERE question_id = ? AND ord = ?",
    [questionId, ord],
  );
  const r = rows[0] as { b64: string } | undefined;
  return r ? r.b64 : null;
}

export async function saveExplainImage(
  questionId: number,
  ord: number,
  caption: string,
  b64: string,
): Promise<void> {
  const p = getPool();
  await p.execute(
    `INSERT INTO ip_explain_image (question_id, ord, caption, b64) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE caption = VALUES(caption), b64 = VALUES(b64)`,
    [questionId, ord, caption.slice(0, 500), b64],
  );
}

/** 某题已生成好的配图序号(给前端知道哪些 ord 直接读图、哪些还要生成)。 */
export async function listExplainImageOrds(questionId: number): Promise<number[]> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT ord FROM ip_explain_image WHERE question_id = ? ORDER BY ord ASC",
    [questionId],
  );
  return (rows as { ord: number }[]).map((r) => Number(r.ord));
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

/* ---------------- 单词本(全局,按遗忘曲线复习) ---------------- */

export type VocabRow = {
  id: number;
  term: string;
  en: string;
  ipa: string;
  zh: string;
  note: string;
  example: string;
  example_zh: string;
  demo: string | null;
  demo_note: string;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  lapses: number;
  due_at: string | null;
  last_reviewed_at: string | null;
  last_grade: string | null;
  is_due: number;
};

function vocabNorm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 255);
}

/** 加入单词本(按归一化词去重:已存在则刷新音标/释义/例句,但保留复习进度)。 */
export async function addVocab(v: {
  term: string;
  en: string;
  ipa: string;
  zh: string;
  note: string;
  example: string;
  exampleZh: string;
  demo: string;
  demoNote: string;
}): Promise<{ id: number; existed: boolean }> {
  await ensureInterviewSchema();
  const p = getPool();
  const norm = vocabNorm(v.term);
  const [res] = await p.execute<ResultSetHeader>(
    `INSERT INTO ip_vocab (term, term_norm, en, ipa, zh, note, example, example_zh, demo, demo_note, due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE en = VALUES(en), ipa = VALUES(ipa), zh = VALUES(zh), note = VALUES(note),
       example = VALUES(example), example_zh = VALUES(example_zh), demo = VALUES(demo), demo_note = VALUES(demo_note)`,
    [
      v.term.trim().slice(0, 255),
      norm,
      v.en.slice(0, 255),
      v.ipa.slice(0, 255),
      v.zh.slice(0, 500),
      v.note.slice(0, 1000),
      v.example.slice(0, 4000) || "(no example)",
      v.exampleZh.slice(0, 1000),
      v.demo.slice(0, 4000) || null,
      v.demoNote.slice(0, 500),
    ],
  );
  const existed = res.affectedRows === 2; // mysql: 1=插入,2=更新已存在行
  const [rows] = await p.execute<RowDataPacket[]>("SELECT id FROM ip_vocab WHERE term_norm = ?", [norm]);
  return { id: Number(rows[0]?.id ?? res.insertId), existed };
}

/** 该词是否已在单词本(按归一化词判断);划词浮层用它显示「已加入」。 */
export async function vocabExists(term: string): Promise<boolean> {
  await ensureInterviewSchema();
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT 1 FROM ip_vocab WHERE term_norm = ? LIMIT 1",
    [vocabNorm(term)],
  );
  return rows.length > 0;
}

/** 全部生词(复习题先、按到期排序);is_due=1 表示现在可复习(新词或已到期)。 */
export async function listVocab(): Promise<VocabRow[]> {
  await ensureInterviewSchema();
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT id, term, en, ipa, zh, note, example, example_zh, demo, demo_note, ease_factor, interval_days,
            repetitions, lapses, due_at, last_reviewed_at, last_grade,
            (last_reviewed_at IS NULL OR due_at IS NULL OR due_at <= NOW()) AS is_due
       FROM ip_vocab
      ORDER BY (last_reviewed_at IS NOT NULL AND due_at IS NOT NULL AND due_at <= NOW()) DESC,
               due_at ASC, id DESC`,
  );
  return (rows as VocabRow[]).map((r) => ({
    ...r,
    ease_factor: Number(r.ease_factor),
    interval_days: Number(r.interval_days),
    repetitions: Number(r.repetitions),
    lapses: Number(r.lapses),
    is_due: Number(r.is_due),
  }));
}

export type VocabCounts = { total: number; due: number; fresh: number; mastered: number };

export async function getVocabCounts(): Promise<VocabCounts> {
  await ensureInterviewSchema();
  const p = getPool();
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total,
        SUM(last_reviewed_at IS NULL) AS fresh,
        SUM(last_reviewed_at IS NULL OR (due_at IS NOT NULL AND due_at <= NOW())) AS due,
        SUM(last_reviewed_at IS NOT NULL AND interval_days >= 21) AS mastered
       FROM ip_vocab`,
  );
  const r = rows[0] ?? {};
  return {
    total: Number(r.total ?? 0),
    due: Number(r.due ?? 0),
    fresh: Number(r.fresh ?? 0),
    mastered: Number(r.mastered ?? 0),
  };
}

export async function getVocab(id: number): Promise<VocabRow | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT id, term, en, ipa, zh, note, example, example_zh, demo, demo_note, ease_factor, interval_days,
            repetitions, lapses, due_at, last_reviewed_at, last_grade, 1 AS is_due
       FROM ip_vocab WHERE id = ?`,
    [id],
  );
  const r = rows[0] as VocabRow | undefined;
  if (!r) return null;
  return {
    ...r,
    ease_factor: Number(r.ease_factor),
    interval_days: Number(r.interval_days),
    repetitions: Number(r.repetitions),
    lapses: Number(r.lapses),
    is_due: Number(r.is_due),
  };
}

/** 更新单词的例句 + 英文读法 + 例子(用于「换个例子」/ 修复旧例句),不动复习进度。 */
export async function updateVocabExample(
  id: number,
  en: string,
  example: string,
  exampleZh: string,
  demo: string,
  demoNote: string,
): Promise<void> {
  const p = getPool();
  await p.execute(
    "UPDATE ip_vocab SET en = ?, example = ?, example_zh = ?, demo = ?, demo_note = ? WHERE id = ?",
    [
      en.slice(0, 255),
      example.slice(0, 4000) || "(no example)",
      exampleZh.slice(0, 1000),
      demo.slice(0, 4000) || null,
      demoNote.slice(0, 500),
      id,
    ],
  );
}

/** 只补/换「例子」(demo,尽量代码片段),保留原例句;给旧词回填用。 */
export async function updateVocabDemo(id: number, demo: string, demoNote: string): Promise<void> {
  const p = getPool();
  await p.execute("UPDATE ip_vocab SET demo = ?, demo_note = ? WHERE id = ?", [
    demo.slice(0, 4000) || null,
    demoNote.slice(0, 500),
    id,
  ]);
}

/** 只补「英文读法」en(+音标),不动例句/例子;给旧词(en 为空、发音会读成中文)回填用。 */
export async function updateVocabReading(id: number, en: string, ipa: string): Promise<void> {
  const p = getPool();
  await p.execute("UPDATE ip_vocab SET en = ?, ipa = ? WHERE id = ?", [
    en.slice(0, 255),
    ipa.slice(0, 255),
    id,
  ]);
}

/** 复习后按 SM-2 更新单词的调度(SQL 侧 DATE_ADD,避免时区漂移)。 */
export async function updateVocabSr(
  id: number,
  update: { ease_factor: number; interval_days: number; repetitions: number; lapses: number },
  grade: string,
): Promise<void> {
  const p = getPool();
  await p.execute(
    `UPDATE ip_vocab
        SET ease_factor = ?, interval_days = ?, repetitions = ?, lapses = ?,
            last_grade = ?, last_reviewed_at = NOW(),
            due_at = DATE_ADD(NOW(), INTERVAL ? DAY)
      WHERE id = ?`,
    [update.ease_factor, update.interval_days, update.repetitions, update.lapses, grade, update.interval_days, id],
  );
}

export async function deleteVocab(id: number): Promise<void> {
  const p = getPool();
  await p.execute("DELETE FROM ip_vocab WHERE id = ?", [id]);
}
