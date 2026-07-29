/**
 * 语音活动检测(VAD)的纯状态机:输入一串音量(RMS)采样,输出「开始说话 / 说完了」两种事件。
 * 录音由调用方(见 audio.ts)按事件启停,一段人声 = 一个音频文件 = 一次转写请求。
 *
 * 为什么不用固定切片:固定每 5 秒切一刀会把词切断、也会把整段静音也发去转写(白花钱)。
 * 这里按「自适应噪声底 + 滞回 + 最短/最长时长」切,和桌面版那套 RMS + 静音判定同一思路。
 *
 * 纯函数 + 纯数据,便于单测(见 vad.test.ts)。
 */

export type VadConfig = {
  /** 绝对静音门槛:再安静的环境也不认为低于这个值是人声 */
  absFloor: number;
  /** 门槛 = max(absFloor, 噪声底 * ratio) */
  ratio: number;
  /** 停止判定用的滞回系数(低于 门槛*hysteresis 才算安静) */
  hysteresis: number;
  /** 连续多久超过门槛才算开始说话(毫秒) */
  onsetMs: number;
  /** 连续多久低于门槛才算说完(毫秒) */
  silenceMs: number;
  /** 一段最长多久必须切开(毫秒),防止有人一口气说 3 分钟 */
  maxSegMs: number;
  /** 一段最短多久才值得发去转写(毫秒),过滤咳嗽/键盘声 */
  minSegMs: number;
  /**
   * 开头这段时间只量噪声、不判人声。少了它,噪声底还停在初值时,
   * 稳定的底噪(风扇声、线路嗡声)会被当成「一直在说话」,而且再也结束不了
   * —— 因为噪声底只在静默期更新。
   */
  warmupMs: number;
};

export const DEFAULT_VAD: VadConfig = {
  absFloor: 0.006,
  ratio: 3,
  hysteresis: 0.65,
  onsetMs: 140,
  silenceMs: 700,
  maxSegMs: 14_000,
  minSegMs: 400,
  warmupMs: 500,
};

export type VadState = {
  speaking: boolean;
  /** 噪声底(只在没人说话时更新) */
  noiseFloor: number;
  /** 连续超过门槛的起点 / 连续低于门槛的起点(null 表示没在计) */
  loudSince: number | null;
  quietSince: number | null;
  /** 当前段的开始时间 */
  segStart: number | null;
  /** 第一次喂采样的时刻(热身判断用;now 是 performance.now(),不从 0 起) */
  firstAt: number | null;
};

export type VadEvent = null | "start" | "stop" | "cut";

export function initVad(): VadState {
  return {
    speaking: false,
    noiseFloor: 0.003,
    loudSince: null,
    quietSince: null,
    segStart: null,
    firstAt: null,
  };
}

/**
 * 喂一个采样。返回新状态与事件:
 *  - "start" 开始录这一段
 *  - "stop"  这一段说完了(调用方停录 → 送转写)
 *  - "cut"   说太久了,先切一刀送出去,同时立刻开始新的一段(仍在说话)
 */
export function stepVad(
  state: VadState,
  rms: number,
  now: number,
  cfg: VadConfig = DEFAULT_VAD,
): { state: VadState; event: VadEvent } {
  const s: VadState = { ...state };
  if (s.firstAt === null) s.firstAt = now;

  // 噪声底只在静默期跟随,避免人声把门槛越推越高(说话越久越听不见)。
  if (!s.speaking) {
    s.noiseFloor = Math.max(0.0005, s.noiseFloor * 0.95 + rms * 0.05);
  }
  const threshold = Math.max(cfg.absFloor, s.noiseFloor * cfg.ratio);
  const loud = rms > threshold;
  const quiet = rms < threshold * cfg.hysteresis;

  if (!s.speaking) {
    // 热身期只量噪声,不判人声。
    if (now - s.firstAt < cfg.warmupMs) {
      s.loudSince = null;
      return { state: s, event: null };
    }
    if (loud) {
      if (s.loudSince === null) s.loudSince = now;
      if (now - s.loudSince >= cfg.onsetMs) {
        s.speaking = true;
        s.segStart = s.loudSince; // 段的起点算在「刚变响」那一刻
        s.loudSince = null;
        s.quietSince = null;
        return { state: s, event: "start" };
      }
    } else {
      s.loudSince = null;
    }
    return { state: s, event: null };
  }

  // 说话中:先看是不是该强制切一刀。
  if (s.segStart !== null && now - s.segStart >= cfg.maxSegMs) {
    s.segStart = now;
    s.quietSince = quiet ? now : null;
    // 一整段都没出现过停顿 → 很可能是中途开始的持续噪声(空调、回声),
    // 顺手把噪声底往当前音量抬一截,下一轮门槛就高过它,能自己走出「永远在说话」。
    if (!quiet) s.noiseFloor = Math.max(s.noiseFloor, rms * 0.5);
    return { state: s, event: "cut" };
  }

  if (quiet) {
    if (s.quietSince === null) s.quietSince = now;
    if (now - s.quietSince >= cfg.silenceMs) {
      s.speaking = false;
      s.segStart = null;
      s.quietSince = null;
      s.loudSince = null;
      // 太短的段(咳嗽、鼠标点击)也照样停录,但调用方会按 minSegMs / 文件大小丢掉不发转写。
      return { state: s, event: "stop" };
    }
  } else {
    s.quietSince = null;
  }
  return { state: s, event: null };
}

/** 从一帧 PCM 波形算 RMS 音量(-1..1 的 Float32Array)。 */
export function rmsOf(frame: Float32Array): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}
