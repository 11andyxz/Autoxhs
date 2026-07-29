import { createHash } from "node:crypto";

import type { RowDataPacket, ResultSetHeader } from "mysql2";

import { synthesizeSpeech } from "@/lib/openai";
import { getPool } from "@/lib/serviceFee/db";

/**
 * 朗读音频缓存。同一句话只合成一次,之后一律从库里取:
 * 面试卡按遗忘曲线要反复读几十遍,每次都调 TTS 既慢又费钱。
 *
 * 表 ip_tts_cache 建在同一 defaultdb,键是 sha256(模型|音色|文本) ——
 * 换音色 / 改了卡片文字 → 键变了 → 自动重新合成,不会读到过时的音。
 */

const MAX_TEXT = 4000; // 与 lib/openai 的 MAX_TTS_CHARS 对齐
/** 单条音频上限 ~4MB(MEDIUMBLOB 上限 16MB);正常一道题的 mp3 只有几十 KB */
const MAX_AUDIO_BYTES = 4_000_000;

function ttsModel(): string {
  return process.env.OPENAI_TTS_MODEL || "tts-1";
}
function ttsVoice(): string {
  return process.env.OPENAI_TTS_VOICE || "onyx";
}

/** 缓存键:模型 + 音色 + 归一化后的文本(压空白,首尾去空) */
export function ttsHash(text: string): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${ttsModel()}|${ttsVoice()}|${norm}`).digest("hex");
}

let ttsSchemaReady: Promise<void> | null = null;

export function ensureTtsSchema(): Promise<void> {
  if (ttsSchemaReady) return ttsSchemaReady;
  ttsSchemaReady = (async () => {
    const p = getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS ip_tts_cache (
        id INT AUTO_INCREMENT PRIMARY KEY,
        text_hash CHAR(64) NOT NULL,
        voice VARCHAR(32) NOT NULL DEFAULT '',
        model VARCHAR(48) NOT NULL DEFAULT '',
        chars INT NOT NULL DEFAULT 0,
        audio MEDIUMBLOB NOT NULL,
        hits INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME NULL,
        UNIQUE KEY uniq_ip_tts_hash (text_hash)
      )
    `);
  })().catch((err) => {
    ttsSchemaReady = null; // 失败不缓存,下次重试
    throw err;
  });
  return ttsSchemaReady;
}

export type TtsResult = { audio: Buffer; hash: string; cached: boolean };

/**
 * 取这句话的音频:命中缓存直接返回,否则调一次 TTS 再写回缓存。
 * 缓存表坏掉(建表失败/查询报错)不影响朗读——退化成每次都合成,只是慢一点。
 */
export async function getOrSynthesize(rawText: string): Promise<TtsResult> {
  const text = rawText.slice(0, MAX_TEXT);
  const hash = ttsHash(text);

  try {
    await ensureTtsSchema();
    const p = getPool();
    const [rows] = await p.execute<RowDataPacket[]>(
      "SELECT audio FROM ip_tts_cache WHERE text_hash = ? LIMIT 1",
      [hash],
    );
    const hit = rows[0] as { audio: Buffer } | undefined;
    if (hit?.audio?.length) {
      // 命中次数只是观察用,失败也无所谓(不要因为它把朗读搞挂)。
      p.execute("UPDATE ip_tts_cache SET hits = hits + 1, last_used_at = NOW() WHERE text_hash = ?", [hash]).catch(
        () => {},
      );
      return { audio: Buffer.from(hit.audio), hash, cached: true };
    }
  } catch (err) {
    console.error("[interview:tts] 读缓存失败,改为直接合成", { code: (err as { code?: string })?.code });
  }

  const audio = await synthesizeSpeech(text);

  if (audio.length <= MAX_AUDIO_BYTES) {
    try {
      const p = getPool();
      // 并发下同一句可能被同时合成:唯一键冲突时保留先写入的那条即可。
      await p.execute<ResultSetHeader>(
        `INSERT INTO ip_tts_cache (text_hash, voice, model, chars, audio, last_used_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE hits = hits + 1, last_used_at = NOW()`,
        [hash, ttsVoice().slice(0, 32), ttsModel().slice(0, 48), text.length, audio],
      );
    } catch (err) {
      console.error("[interview:tts] 写缓存失败(不影响本次朗读)", { code: (err as { code?: string })?.code });
    }
  }

  return { audio, hash, cached: false };
}
