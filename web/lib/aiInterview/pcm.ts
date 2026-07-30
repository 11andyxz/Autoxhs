/**
 * 处理「本机辅助程序」送过来的裸 PCM(Int16LE 单声道)。
 *
 * 走辅助程序时不再经过 MediaRecorder / WebAudio:拿到的是原始样本,自己算音量喂 VAD、
 * 自己按 WAV 打包送转写。好处是**前摇是精确的**(从环形缓冲往前取,不用 DelayNode 那套
 * 近似手法),而且少一层浏览器编码器的怪毛病。
 *
 * 纯数据 + 纯函数,可单测(见 pcm.test.ts)。
 */

/** Int16LE 字节 → Int16Array(处理奇数字节:留一个字节给下一批) */
export function bytesToInt16(bytes: Uint8Array): { samples: Int16Array; leftover: Uint8Array } {
  const usable = bytes.length - (bytes.length % 2);
  const samples = new Int16Array(usable / 2);
  for (let i = 0; i < usable; i += 2) {
    samples[i / 2] = (bytes[i] | (bytes[i + 1] << 8)) << 16 >> 16; // 小端 + 符号扩展
  }
  return { samples, leftover: bytes.subarray(usable) };
}

/** 一段 Int16 样本的 RMS(归一化到 -1..1 再算,和 WebAudio 那条路口径一致) */
export function rmsOfInt16(samples: Int16Array, from = 0, to = samples.length): number {
  const end = Math.min(to, samples.length);
  const start = Math.max(0, from);
  const n = end - start;
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = start; i < end; i += 1) {
    const v = samples[i] / 32_768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/**
 * 环形缓冲:只保留最近 capacity 个样本。
 * 用「累计写入数」当全局样本时钟,切段时按绝对样本号取范围,不用自己算绕圈。
 */
export class PcmRing {
  private readonly buf: Int16Array;
  private written = 0;

  constructor(readonly capacity: number) {
    this.buf = new Int16Array(capacity);
  }

  /** 已写入的总样本数(单调递增,可当时钟) */
  get end(): number {
    return this.written;
  }

  /** 缓冲里还留着的最早样本号 */
  get start(): number {
    return Math.max(0, this.written - this.capacity);
  }

  write(samples: Int16Array): void {
    let src = samples;
    if (src.length > this.capacity) {
      // 一次写超过容量:前面那些反正读不到了,直接跳过 —— 但**时钟必须照样推进**,
      // 否则样本号和缓冲里的位置(按 号 % capacity 存放)会错位,读出来是乱序的。
      const drop = src.length - this.capacity;
      this.written += drop;
      src = src.subarray(drop);
    }
    const offset = this.written % this.capacity;
    const firstPart = Math.min(src.length, this.capacity - offset);
    this.buf.set(src.subarray(0, firstPart), offset);
    if (firstPart < src.length) this.buf.set(src.subarray(firstPart), 0);
    this.written += src.length;
  }

  /** 取 [from, to) 区间(按绝对样本号;超出保留范围的部分自动裁掉) */
  slice(from: number, to: number): Int16Array {
    const lo = Math.max(from, this.start);
    const hi = Math.min(to, this.written);
    if (hi <= lo) return new Int16Array(0);
    const out = new Int16Array(hi - lo);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = this.buf[(lo + i) % this.capacity];
    }
    return out;
  }
}

/** 转写模型内部就是 16k;再高的采样率只是白传字节、白等上传 */
export const TRANSCRIBE_RATE = 16_000;

/**
 * 整数倍降采样到 16k(48k → 16k 就是 3 合 1)。
 * 用等长平均当最简单的低通,避免直接抽点带来的折叠噪声;不是整数倍就原样返回。
 */
export function downsampleForTranscribe(
  samples: Int16Array,
  srcRate: number,
): { samples: Int16Array; rate: number } {
  if (srcRate <= TRANSCRIBE_RATE || srcRate % TRANSCRIBE_RATE !== 0) {
    return { samples, rate: srcRate };
  }
  const factor = srcRate / TRANSCRIBE_RATE;
  const out = new Int16Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i += 1) {
    let sum = 0;
    for (let k = 0; k < factor; k += 1) sum += samples[i * factor + k];
    out[i] = Math.round(sum / factor);
  }
  return { samples: out, rate: TRANSCRIBE_RATE };
}

/** 把 Int16 单声道样本打成 WAV 字节(16-bit PCM),whisper 直接吃。 */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 每帧字节
  view.setUint16(34, 16, true); // 位深
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, samples[i], true);
  }
  return out;
}
