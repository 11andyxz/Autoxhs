/**
 * 语音活动检测(VAD)的纯状态机:输入一串音量(RMS)采样,输出「开始说话 / 说完了」两种事件。
 * 录音由调用方(见 audio.ts)按事件启停,一段人声 = 一个音频文件 = 一次转写请求。
 *
 * 为什么不用固定切片:固定每 5 秒切一刀会把词切断、也会把整段静音也发去转写(白花钱)。
 * 这里按「自适应噪声底 + 滞回 + 最短/最长时长」切,和桌面版那套 RMS + 静音判定同一思路。
 *
 * 纯函数 + 纯数据,便于单测(见 vad.test.ts)。
 *
 * ⚠️ 两条铁律来自 2026-07-29 实测到的真实故障(整段问题听不见,详见 vad.test.ts 里的回归用例):
 *  1)**噪声底只能用「安静」的采样更新**。曾经写成「只要不在 speaking 就更新」——
 *     一段结束后对方还在继续说,底噪就拿人声当背景来学,门槛(=底噪×3)每帧往上棘轮:
 *     0.10 → 0.15 → 0.20 → 0.24…真人语音每 50~100ms 有一次词间下探,一下探就低于这个
 *     被抬高的门槛,起始计时归零,于是**永远攒不满 onsetMs,再也不开录音**,要等一段长静音
 *     把底噪衰减回去才自愈(实测哑了 38.5 秒,吃掉两整道题)。
 *  2)**起始判定要容忍词间下探**(onsetHoldMs)。真人不是恒定音量,要求「连续」超过门槛
 *     在真实语音上极易被打断 —— 合成的恒定音量测试信号看不出这个问题。
 */

export type VadConfig = {
  /**
   * 绝对下限:只是兜底,防止在数字静音上被极小的浮点噪声触发。
   * **千万别把它调高当主门槛用** —— 真正干活的是自适应底噪(noiseFloor × ratio)。
   * 实测各路音源的语音电平差两个数量级:Chrome 标签页音频峰值 0.28~0.38,
   * 而 Zoom 经系统音出来只有 0.048(p50 仅 0.0016),数字静音是 0.00003。
   * 这个值曾经写成 0.006(照 Chrome 调的),结果 Zoom 那条路整句话**一段都切不出来**
   * (实测:125 个块只有 9% 过线 → 0 段),面试官问了什么完全看不见。
   */
  absFloor: number;
  /** 门槛 = max(absFloor, 噪声底 * ratio) */
  ratio: number;
  /** 停止判定用的滞回系数(低于 门槛*hysteresis 才算安静) */
  hysteresis: number;
  /** 累计多久超过门槛才算开始说话(毫秒) */
  onsetMs: number;
  /** 起始判定期间,低于门槛多久才作废这次候选(容忍词间的短暂下探) */
  onsetHoldMs: number;
  /** 连续多久低于门槛才算说完(毫秒) */
  silenceMs: number;
  /** 一段最长多久必须切开(毫秒),防止有人一口气说 3 分钟 */
  maxSegMs: number;
  /** 一段最短多久才值得发去转写(毫秒),过滤咳嗽/键盘声 */
  minSegMs: number;
  /**
   * 开头这段时间只量噪声、不判人声(此期间底噪吃所有采样,把环境底噪量出来)。
   * 少了它,噪声底还停在初值时,稳定的底噪(风扇声、线路嗡声)会被当成「一直在说话」。
   */
  warmupMs: number;
};

export const DEFAULT_VAD: VadConfig = {
  absFloor: 0.0012,
  ratio: 3,
  hysteresis: 0.65,
  onsetMs: 140,
  onsetHoldMs: 160,
  silenceMs: 700,
  maxSegMs: 14_000,
  minSegMs: 400,
  warmupMs: 500,
};

/** 底噪下限;再安静的环境也不把门槛压到 0 */
const MIN_FLOOR = 0.0005;
/** 变安静时跟得快(新值权重),变吵时抬得慢 —— 慢到足以区分「持续底噪」和「人在说话」 */
const FLOOR_DOWN_W = 0.3;
const FLOOR_UP_W = 0.005;
/**
 * 热身期用快权重:那几百毫秒的任务就是「把环境底噪量出来」,越快越好
 * (环境本来就吵时,底噪必须在热身结束前追上去,否则一开始就会把底噪当人声)。
 */
const FLOOR_WARMUP_W = 0.2;
/**
 * 热身期量出来的底噪上限。比这还响就不像「房间底噪」,更像是**开始那一刻对方正在说话**
 * (或音乐/回声);那种情况按人声处理更好 —— 真是持续噪声的话,会在 maxSegMs 强制切段时
 * 由那里的底噪抬升自愈,而不是一上来就把整场都当背景音听不见。
 */
const FLOOR_WARMUP_MAX = 0.02;

export type VadState = {
  speaking: boolean;
  /** 噪声底(只用安静采样更新;热身期吃所有采样) */
  noiseFloor: number;
  /** 本次「候选起始」的起点(累计够 onsetMs 就算开始说话) */
  loudSince: number | null;
  /** 候选起始期间最后一次超过门槛的时刻(用于容忍词间下探) */
  lastLoudAt: number | null;
  /** 连续低于门槛的起点 */
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
    lastLoudAt: null,
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
  const warming = now - s.firstAt < cfg.warmupMs;

  const threshold = Math.max(cfg.absFloor, s.noiseFloor * cfg.ratio);
  const loud = rms > threshold;
  const quiet = rms < threshold * cfg.hysteresis;

  // 底噪更新(见文件头铁律 1):
  //  - 热身期:吃所有采样,把环境底噪量出来(哪怕环境本身就很吵)。
  //  - 之后:只吃「不响」的采样,且下降快、上升慢。人声永远不参与,门槛不会被自己推高;
  //    持续存在的噪声(空调、回声)仍会被慢慢抬进底噪里,配合 maxSegMs 的强制切段自愈。
  if (!s.speaking && (warming || !loud)) {
    const w = warming ? FLOOR_WARMUP_W : rms < s.noiseFloor ? FLOOR_DOWN_W : FLOOR_UP_W;
    const next = Math.max(MIN_FLOOR, s.noiseFloor * (1 - w) + rms * w);
    s.noiseFloor = warming ? Math.min(next, Math.max(s.noiseFloor, FLOOR_WARMUP_MAX)) : next;
  }

  if (!s.speaking) {
    // 热身期只量噪声,不判人声。
    if (warming) {
      s.loudSince = null;
      s.lastLoudAt = null;
      return { state: s, event: null };
    }
    if (loud) {
      if (s.loudSince === null) s.loudSince = now;
      s.lastLoudAt = now;
      if (now - s.loudSince >= cfg.onsetMs) {
        s.speaking = true;
        s.segStart = s.loudSince; // 段的起点算在「刚变响」那一刻
        s.loudSince = null;
        s.lastLoudAt = null;
        s.quietSince = null;
        return { state: s, event: "start" };
      }
    } else if (s.loudSince !== null && now - (s.lastLoudAt ?? now) > cfg.onsetHoldMs) {
      // 铁律 2:只有「真的安静下来」才作废候选;词间的一两帧下探不算。
      s.loudSince = null;
      s.lastLoudAt = null;
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
      s.lastLoudAt = null;
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
