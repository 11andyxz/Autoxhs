import type { RowDataPacket, ResultSetHeader } from "mysql2";

import { getPool } from "@/lib/serviceFee/db";

import type { Grade, QuestionType } from "./schema";

/**
 * 面试训练的持久化层。复用收费计算器的同一个 MySQL 连接池(getPool),
 * 表统一加 ip_ 前缀,建在同一 defaultdb 里;ensureInterviewSchema 幂等建表。
 */

let schemaReady: Promise<void> | null = null;

export function ensureInterviewSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
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
  })();
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

export async function getSession(id: number): Promise<SessionRow | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id, language, jd_text, resume_text FROM ip_session WHERE id = ?",
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
};

export async function getQuestion(id: number): Promise<QuestionRow | null> {
  const p = getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    "SELECT id, session_id, skill_id, type, prompt, reference_answer, rubric_json FROM ip_question WHERE id = ?",
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
  const out: string[] = [];
  for (const r of rows) {
    const g = asJson<Grade>(r.score_json);
    out.push(...(g.misses || []), ...(g.errors || []));
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
