import {
  PcmRing,
  bytesToInt16,
  downsampleForTranscribe,
  encodeWav,
  rmsOfInt16,
} from "./pcm";
import { DEFAULT_VAD, initVad, rmsOf, stepVad, type VadConfig, type VadState } from "./vad";

/**
 * 浏览器侧的双通道听音引擎(只在客户端跑,依赖 WebAudio / MediaRecorder)。
 *
 * 桌面版那类工具用原生模块抓系统音;浏览器里拿不到系统音,可选两条路:
 *  1)display:共享「Chrome 标签页」并勾选「同时分享标签页音频」→ 拿到会议网页的声音
 *     (Zoom Web / Google Meet / Teams Web 都适用),顺带拿到画面用于截屏解题;
 *  2)device:把桌面客户端的声音用虚拟声卡(macOS 上如 BlackHole)回灌成一个输入设备,
 *     这里把它当麦克风来听 —— 桌面版 Zoom / Teams 走这条。
 *
 * 每个通道的音频图:
 *   source ─┬─ vad-meter(AudioWorklet) ─ gain(0) ─ destination   算音量喂 VAD(gain 0 → 不出声)
 *           └─ delay(0.35s) ─ dest ─ MediaRecorder                 录的是延迟信号 = 自带前摇
 * 录延迟信号是为了不切掉句子开头:VAD 判出「开始说话」总比实际晚一点(约 180ms),
 * 录一路慢 350ms 的信号,等于把开头补回来。
 *
 * **时钟必须走音频线程,不能用 setInterval**:面试时这个页面很可能被会议窗口挡住,
 * 而 Chrome 会把隐藏标签页的定时器压到 1 秒一次(超过 5 分钟更狠,可能 1 分钟一次)。
 * 那样 VAD 会晚一两秒才发现有人说话,每个问题的开头都被吃掉,答案也会迟到。
 * AudioWorklet 跑在音频线程,不受页面可见性影响;它每 ~43ms 往主线程发一次音量,
 * 段落起停、延迟停录、页面侧的防抖都挂在这条消息上(见 onHeartbeat)。
 */

export type Channel = "interviewer" | "me";

export type Segment = {
  channel: Channel;
  blob: Blob;
  ext: string;
  /** 相对开始时间的毫秒偏移 */
  startedAt: number;
  endedAt: number;
};

export type CaptureHandlers = {
  onSegment: (segment: Segment) => void;
  onLevel: (channel: Channel, level: number) => void;
  onError: (channel: Channel, message: string) => void;
  /** 用户点了「停止共享」或设备被拔掉(不可恢复) */
  onEnded: (channel: Channel) => void;
  /** 采集掉线 / 恢复(辅助程序被系统掐断后会自动重连,期间 up=false) */
  onSourceState?: (channel: Channel, up: boolean) => void;
  /**
   * 不受标签页节流影响的心跳(~200ms 一次,由音频线程驱动)。
   * 页面把「等对方说完再回答」这类延时判断挂在这里,而不是 setTimeout。
   */
  onHeartbeat?: (now: number) => void;
};

/** 录音相对实时信号的延迟(= 前摇长度) */
const PREROLL_MS = 350;
/** 退化路径(没有 AudioWorklet 时)的采样间隔 */
const TICK_MS = 80;
/** 心跳节流 */
const BEAT_MS = 200;
/** 小于这个大小的片段不当人声(WebM 头本身就有几百字节) */
const MIN_SEGMENT_BYTES = 2_000;

/** 音量表 worklet:每 ~2048 帧(48k 下约 43ms)往主线程发一次 RMS。 */
const WORKLET_SRC = `
class VadMeter extends AudioWorkletProcessor {
  constructor() { super(); this.acc = 0; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      this.acc += sum;
      this.n += ch.length;
    } else {
      this.n += 128; // 没有输入也当静音推进,保证心跳不断
    }
    if (this.n >= 2048) {
      this.port.postMessage(Math.sqrt(this.acc / this.n));
      this.acc = 0;
      this.n = 0;
    }
    return true;
  }
}
registerProcessor('vad-meter', VadMeter);
`;

const workletReady = new WeakMap<AudioContext, Promise<boolean>>();

/** 给这个 AudioContext 装上 vad-meter(每个 context 只装一次)。装不上就返回 false 走退化路径。 */
function ensureWorklet(ctx: AudioContext): Promise<boolean> {
  const cached = workletReady.get(ctx);
  if (cached) return cached;
  const promise = (async () => {
    if (!ctx.audioWorklet) return false;
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
      return true;
    } catch {
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  workletReady.set(ctx, promise);
  return promise;
}

function pickMime(): { mime: string; ext: string } {
  const candidates: Array<[string, string]> = [
    ["audio/webm;codecs=opus", "webm"],
    ["audio/webm", "webm"],
    ["audio/mp4", "mp4"], // Safari
    ["audio/ogg;codecs=opus", "ogg"],
  ];
  for (const [mime, ext] of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) {
      return { mime, ext };
    }
  }
  return { mime: "", ext: "webm" };
}

/** 列出可用的音频输入设备(拿到麦克风权限后 label 才有内容)。 */
export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

/* ============================ 单通道 ============================ */

class ChannelPipeline {
  private dest: MediaStreamAudioDestinationNode;
  private meter: AudioWorkletNode | null = null;
  private zero: GainNode | null = null;
  /** 退化路径:没有 worklet 时用 analyser + 外部定时器 */
  private analyser: AnalyserNode | null = null;
  private frame: Float32Array<ArrayBuffer> | null = null;
  private vad: VadState = initVad();
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private segStart = 0;
  private pendingRestart = false;
  /** 到点才真正停录(录的是延迟信号,尾巴还在管子里);用音频时钟判,不用定时器 */
  private pendingStopAt: number | null = null;
  private stopped = false;
  private readonly mime: string;
  private readonly ext: string;
  private levelSentAt = 0;
  private smoothLevel = 0;

  constructor(
    readonly channel: Channel,
    private readonly ctx: AudioContext,
    readonly stream: MediaStream,
    private readonly handlers: CaptureHandlers,
    private readonly t0: number,
    useWorklet: boolean,
    private readonly beat: (now: number) => void,
    private readonly cfg: VadConfig = DEFAULT_VAD,
  ) {
    const source = ctx.createMediaStreamSource(stream);

    if (useWorklet) {
      this.meter = new AudioWorkletNode(ctx, "vad-meter", { numberOfOutputs: 1 });
      this.meter.port.onmessage = (e) => this.onRms(Number(e.data) || 0, performance.now());
      source.connect(this.meter);
      // 必须接到 destination 图才会被拉动;gain 0 → 一点声音都不会放出来(也不会有回声)。
      this.zero = ctx.createGain();
      this.zero.gain.value = 0;
      this.meter.connect(this.zero);
      this.zero.connect(ctx.destination);
    } else {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.2;
      source.connect(this.analyser);
      this.frame = new Float32Array(this.analyser.fftSize);
    }

    const delay = ctx.createDelay(1);
    delay.delayTime.value = PREROLL_MS / 1000;
    this.dest = ctx.createMediaStreamDestination();
    source.connect(delay);
    delay.connect(this.dest);

    const picked = pickMime();
    this.mime = picked.mime;
    this.ext = picked.ext;

    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (!this.stopped) this.handlers.onEnded(this.channel);
      });
    }
  }

  /** 退化路径由 LiveCapture 的定时器调用;worklet 路径不用。 */
  tick(now: number): void {
    if (this.stopped || !this.analyser || !this.frame) return;
    this.analyser.getFloatTimeDomainData(this.frame);
    this.onRms(rmsOf(this.frame), now);
  }

  /** 收到一个音量采样:更新音量条 → 处理待停录 → 喂 VAD → 按事件启停录音。 */
  private onRms(rms: number, now: number): void {
    if (this.stopped) return;

    // 音量条:平滑一下,不然抖得看不清;发送节流,别每 43ms 就 setState 一次。
    this.smoothLevel = this.smoothLevel * 0.7 + Math.min(1, rms * 12) * 0.3;
    if (now - this.levelSentAt >= 120) {
      this.levelSentAt = now;
      this.handlers.onLevel(this.channel, this.smoothLevel);
    }
    this.beat(now);

    if (this.pendingStopAt !== null && now >= this.pendingStopAt) {
      this.pendingStopAt = null;
      this.stopRecorderNow();
    }

    const { state, event } = stepVad(this.vad, rms, now, this.cfg);
    this.vad = state;
    if (event === "start") {
      if (this.pendingStopAt !== null && this.recorder) {
        // 刚判完「说完了」又立刻响起来(中间只隔了不到 0.4 秒):当同一段继续录,别切开。
        this.pendingStopAt = null;
        this.pendingRestart = false;
      } else {
        this.beginSegment(now);
      }
    } else if (event === "stop") {
      this.endSegment(PREROLL_MS + 60, false);
    } else if (event === "cut") {
      this.endSegment(0, true);
    }

    // 不变量:VAD 认为有人在说话,就必须正在录。
    // 「start」和「待停录」撞在同一帧时,旧录音器还没走完 onstop(异步),beginSegment 会被
    // this.recorder 挡掉 —— 于是状态机在说话、却没人录音,这一段就凭空消失了。
    // 这里补一枪,把这类竞态自愈掉(2026-07-29 实测过整段问题丢失)。
    if (this.vad.speaking && !this.recorder && this.pendingStopAt === null) {
      this.beginSegment(now);
    }
  }

  private beginSegment(now: number): void {
    if (this.recorder || this.stopped) return;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        this.dest.stream,
        this.mime ? { mimeType: this.mime, audioBitsPerSecond: 64_000 } : undefined,
      );
    } catch {
      this.handlers.onError(this.channel, "这个浏览器不支持录音(MediaRecorder)。");
      this.stopped = true;
      return;
    }

    this.chunks = [];
    this.segStart = now;
    recorder.ondataavailable = (e) => {
      if (e.data?.size) this.chunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mime || "audio/webm" });
      this.chunks = [];
      this.recorder = null;
      const endedAt = performance.now();
      const durMs = endedAt - this.segStart;
      if (blob.size >= MIN_SEGMENT_BYTES && durMs >= this.cfg.minSegMs) {
        this.handlers.onSegment({
          channel: this.channel,
          blob,
          ext: this.ext,
          // 段的开始时间要把前摇减回去,字幕时间轴才对得上。
          startedAt: Math.max(0, Math.round(this.segStart - this.t0 - PREROLL_MS)),
          endedAt: Math.max(0, Math.round(endedAt - this.t0)),
        });
      }
      if (this.pendingRestart && !this.stopped) {
        this.pendingRestart = false;
        this.beginSegment(performance.now());
      }
    };
    recorder.onerror = () => {
      this.chunks = [];
      this.recorder = null;
    };

    try {
      recorder.start();
      this.recorder = recorder;
    } catch {
      this.handlers.onError(this.channel, "录音启动失败,请重新开始。");
    }
  }

  private stopRecorderNow(): void {
    const recorder = this.recorder;
    if (!recorder) return;
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      /* 已经停了 */
    }
  }

  private endSegment(deferMs: number, restart: boolean): void {
    if (!this.recorder) {
      // 没有在录却要求「切一刀继续录」:直接开新的一段(别把 restart 意图丢掉)。
      if (restart && !this.stopped) this.beginSegment(performance.now());
      return;
    }
    this.pendingRestart = restart;
    if (deferMs > 0) this.pendingStopAt = performance.now() + deferMs;
    else this.stopRecorderNow();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pendingRestart = false;
    this.pendingStopAt = null;
    // 停之前把手上这段收尾发出去(最后一个问题往往正好在这一刻)。
    // recorder.stop() 是异步收尾的,轨道要晚一点再断,否则最后一段会被截掉。
    this.stopRecorderNow();
    if (this.meter) {
      this.meter.port.onmessage = null;
      this.meter.disconnect();
      this.zero?.disconnect();
    }
    const tracks = this.stream.getTracks();
    window.setTimeout(() => tracks.forEach((t) => t.stop()), 600);
  }
}

/* ============================ 辅助程序(裸 PCM)通道 ============================ */

/** 两种通道的共同外壳,LiveCapture 统一管理 */
type Pipeline = { readonly channel: Channel; tick(now: number): void; stop(): void };

/** 一次处理多少样本算一帧音量(48k 下约 43ms,和 worklet 那条路口径一致) */
const PCM_BLOCK = 2_048;
/** 环形缓冲留多久(秒):要够放「前摇 + 一整段话」 */
const PCM_RING_SECONDS = 20;

/**
 * 本机辅助程序那条路的通道:输入是裸 PCM,自己算音量、自己切段、自己打 WAV。
 * 前摇是精确的(从环形缓冲往前取 PREROLL_MS),不需要 DelayNode 那种近似做法。
 */
class PcmPipeline implements Pipeline {
  private ring: PcmRing;
  private leftover = new Uint8Array(0);
  private pending: Int16Array[] = [];
  private pendingLen = 0;
  private vad: VadState = initVad();
  private segStartSample: number | null = null;
  private stopped = false;
  private smoothLevel = 0;
  private levelSentAt = 0;
  /** 样本时钟起点:这一路的第 0 个样本对应的「会话内毫秒」 */
  private readonly baseMs: number;

  constructor(
    readonly channel: Channel,
    private readonly sampleRate: number,
    private readonly handlers: CaptureHandlers,
    t0: number,
    private readonly beat: (now: number) => void,
    private readonly cfg: VadConfig = DEFAULT_VAD,
  ) {
    this.ring = new PcmRing(sampleRate * PCM_RING_SECONDS);
    this.baseMs = performance.now() - t0;
  }

  /** 辅助程序每来一批字节就喂进来 */
  push(bytes: Uint8Array): void {
    if (this.stopped) return;
    const merged =
      this.leftover.length === 0
        ? bytes
        : (() => {
            const m = new Uint8Array(this.leftover.length + bytes.length);
            m.set(this.leftover);
            m.set(bytes, this.leftover.length);
            return m;
          })();
    const { samples, leftover } = bytesToInt16(merged);
    this.leftover = leftover.slice();
    if (!samples.length) return;

    this.pending.push(samples);
    this.pendingLen += samples.length;
    while (this.pendingLen >= PCM_BLOCK) this.processBlock();
  }

  /** 取出一整块(可能跨多批)交给 VAD */
  private processBlock(): void {
    const block = new Int16Array(PCM_BLOCK);
    let filled = 0;
    while (filled < PCM_BLOCK) {
      const head = this.pending[0];
      const take = Math.min(head.length, PCM_BLOCK - filled);
      block.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) this.pending.shift();
      else this.pending[0] = head.subarray(take);
    }
    this.pendingLen -= PCM_BLOCK;
    this.ring.write(block);

    // 时间用「样本时钟」推:不受主线程卡顿影响,也不受标签页节流影响。
    const now = this.sampleToMs(this.ring.end);
    const rms = rmsOfInt16(block);

    this.smoothLevel = this.smoothLevel * 0.7 + Math.min(1, rms * 12) * 0.3;
    const wall = performance.now();
    if (wall - this.levelSentAt >= 120) {
      this.levelSentAt = wall;
      this.handlers.onLevel(this.channel, this.smoothLevel);
    }
    this.beat(wall);

    const { state, event } = stepVad(this.vad, rms, now, this.cfg);
    this.vad = state;
    if (event === "start") {
      const preroll = Math.round((PREROLL_MS / 1000) * this.sampleRate);
      this.segStartSample = Math.max(0, this.ring.end - PCM_BLOCK - preroll);
    } else if (event === "stop" || event === "cut") {
      this.flushSegment();
      if (event === "cut") this.segStartSample = this.ring.end;
    }
  }

  private sampleToMs(sample: number): number {
    return this.baseMs + (sample / this.sampleRate) * 1000;
  }

  private flushSegment(): void {
    const from = this.segStartSample;
    this.segStartSample = null;
    if (from === null) return;
    const samples = this.ring.slice(from, this.ring.end);
    const durMs = (samples.length / this.sampleRate) * 1000;
    if (durMs < this.cfg.minSegMs) return;
    // 降到 16k 再打包:转写模型内部就是这个采样率,48k 的 WAV 只是白传 3 倍字节。
    const down = downsampleForTranscribe(samples, this.sampleRate);
    const wav = encodeWav(down.samples, down.rate);
    this.handlers.onSegment({
      channel: this.channel,
      blob: new Blob([wav as unknown as BlobPart], { type: "audio/wav" }),
      ext: "wav",
      startedAt: Math.max(0, Math.round(this.sampleToMs(from))),
      endedAt: Math.max(0, Math.round(this.sampleToMs(this.ring.end))),
    });
  }

  /** worklet 那条路用不到;这里保留接口以统一管理 */
  tick(): void {}

  stop(): void {
    if (this.stopped) return;
    // 收尾:手上这段也发出去(最后一个问题常常正好在这一刻)
    this.flushSegment();
    this.stopped = true;
  }
}

/* ============================ 引擎 ============================ */

export type InterviewerSource =
  | { kind: "display" }
  | { kind: "device"; deviceId: string }
  | { kind: "helper"; port: number; token: string };

export class LiveCapture {
  private ctx: AudioContext | null = null;
  private channels = new Map<Channel, Pipeline>();
  /** 走辅助程序时:画面从它的 /frame 拿,不需要再申请屏幕共享 */
  private helper: { port: number; token: string } | null = null;
  private helperAbort: AbortController | null = null;
  /** stop() 之后不再重连 */
  private stopping = false;
  private timer: number | null = null;
  private t0 = 0;
  private lastBeat = 0;
  /** 共享屏幕的视频轨:用于「截屏解题」 */
  private displayStream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private readonly beat = (now: number) => {
    if (now - this.lastBeat < BEAT_MS) return;
    this.lastBeat = now;
    this.handlers.onHeartbeat?.(now);
  };

  constructor(private readonly handlers: CaptureHandlers) {}

  /** 会话开始时间(performance.now 基准),字幕时间戳都相对它 */
  get startedAt(): number {
    return this.t0;
  }

  get elapsed(): number {
    return this.t0 ? performance.now() - this.t0 : 0;
  }

  private audioContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.t0 = performance.now();
    }
    void this.ctx.resume();
    return this.ctx;
  }

  /** 只有退化路径(没装上 worklet)才需要这个定时器 */
  private startFallbackTimer(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      const now = performance.now();
      for (const pipeline of this.channels.values()) pipeline.tick(now);
    }, TICK_MS);
  }

  /** 开麦克风(听我自己说的话,用来判断「我在答」以及记录全文) */
  async startMic(deviceId?: string): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    await this.addChannel("me", stream);
  }

  /**
   * 开面试官声道。display 会弹出共享选择器(**必须选「Chrome 标签页」并勾上分享音频**,
   * 选整个屏幕/窗口在 macOS 上拿不到声音);device 直接听某个输入设备(虚拟声卡)。
   */
  async startInterviewer(source: InterviewerSource): Promise<void> {
    if (source.kind === "helper") {
      await this.startFromHelper(source.port, source.token);
      return;
    }
    if (source.kind === "device") {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: source.deviceId },
          // 虚拟声卡进来的是「原始的会议声音」,别让浏览器再降噪/自动增益。
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      await this.addChannel("interviewer", stream);
      return;
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.displayStream = stream;
    if (!stream.getAudioTracks().length) {
      // 画面留着(截屏解题还用得上),但明确告诉用户没拿到声音。
      throw new Error(
        "这次共享没有带音频。请重新开始,并在选择器里选「Chrome 标签页」+ 勾选「同时分享标签页音频」;若面试用的是桌面客户端,请改用「虚拟声卡」方式。",
      );
    }
    // 只把音频轨交给听音管线,视频轨留给截屏。
    const audioOnly = new MediaStream(stream.getAudioTracks());
    await this.addChannel("interviewer", audioOnly);
    for (const track of stream.getVideoTracks()) {
      track.addEventListener("ended", () => this.handlers.onEnded("interviewer"));
    }
  }

  /**
   * 从本机辅助程序拉「系统声音」:一条 chunked 的裸 PCM 流,边收边喂 PcmPipeline。
   * 这条路不需要共享标签页,也不需要虚拟声卡 —— 桌面版 Zoom / Teams 走它。
   */
  private async startFromHelper(port: number, token: string): Promise<void> {
    const base = `http://127.0.0.1:${port}`;
    const health = (await fetch(`${base}/health?t=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(4_000),
    }).then((r) => r.json())) as {
      ok?: boolean;
      sampleRate?: number;
      permission?: boolean;
      tokenOk?: boolean;
    };
    if (!health.ok || !health.tokenOk) throw new Error("辅助程序拒绝了连接(配对信息不对)。");
    if (!health.permission) {
      throw new Error(
        "辅助程序还没拿到「屏幕录制」权限:到「系统设置 → 隐私与安全性 → 屏幕录制」勾上运行它的终端,重开终端再跑一次。",
      );
    }
    const sampleRate = health.sampleRate || 48_000;

    // 时钟基准要在建管线之前就位(音频时间戳都相对它)
    this.audioContextlessInit();
    const pipeline = new PcmPipeline(
      "interviewer",
      sampleRate,
      this.handlers,
      this.t0,
      this.beat,
    );
    this.channels.get("interviewer")?.stop();
    this.channels.set("interviewer", pipeline);
    this.helper = { port, token };

    const controller = new AbortController();
    this.helperAbort = controller;
    const res = await fetch(`${base}/audio?t=${encodeURIComponent(token)}`, {
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error("辅助程序的音频流打不开。");

    // 后台一直读,直到 stop() 取消;中途断了自己重连(辅助程序被系统掐断后会重启并换 token)
    void this.pumpHelper(res, pipeline, controller);
  }

  /**
   * 一直读辅助程序的 PCM 流;流断了就自己重连。
   *
   * 为什么必须重连:macOS 会因为息屏/换显示器/系统那个「正在录屏」提示等原因掐断 SCStream,
   * 辅助程序重启采集后**会换一个新 token**,所以重连要重新问一次 /api/ai-interview/helper。
   * 实测过一次「面试中途耳朵没了、页面还显示进行中」——这条路不能只弹提示就算完。
   */
  private async pumpHelper(
    res: Response,
    pipeline: PcmPipeline,
    controller: AbortController,
  ): Promise<void> {
    const reader = res.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) pipeline.push(value);
      }
    } catch {
      /* 断了,下面统一处理 */
    }
    if (controller.signal.aborted || this.stopping) return;

    this.handlers.onSourceState?.("interviewer", false);
    // 重连:辅助程序可能正在自我重启,端口/token 都要重新问
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      if (this.stopping) return;
      await new Promise((r) => window.setTimeout(r, Math.min(3_000, 500 * attempt)));
      try {
        const info = (await fetch("/api/ai-interview/helper").then((r) => r.json())) as {
          available?: boolean;
          port?: number;
          token?: string;
        };
        if (!info.available || !info.port || !info.token) continue;
        await this.startFromHelper(info.port, info.token);
        this.handlers.onSourceState?.("interviewer", true);
        return;
      } catch {
        /* 再试 */
      }
    }
    this.handlers.onError("interviewer", "和辅助程序断开且重连失败,请在页面上重新启动辅助程序。");
    this.handlers.onEnded("interviewer");
  }

  /** 辅助程序那条路不需要 AudioContext,但会话时钟(t0)还是要有 */
  private audioContextlessInit(): void {
    if (!this.t0) this.t0 = performance.now();
  }

  private async addChannel(channel: Channel, stream: MediaStream): Promise<void> {
    this.channels.get(channel)?.stop();
    const ctx = this.audioContext();
    const useWorklet = await ensureWorklet(ctx);
    const pipeline = new ChannelPipeline(
      channel,
      ctx,
      stream,
      this.handlers,
      this.t0,
      useWorklet,
      this.beat,
    );
    this.channels.set(channel, pipeline);
    if (!useWorklet) this.startFallbackTimer();
  }

  has(channel: Channel): boolean {
    return this.channels.has(channel);
  }

  /** 有没有可截屏的画面(走 display 共享,或有辅助程序在持续盯着屏幕) */
  get canScreenshot(): boolean {
    if (this.helper) return true;
    return !!this.displayStream?.getVideoTracks().some((t) => t.readyState === "live");
  }

  /**
   * 单独申请一次屏幕共享,只为截屏(走「虚拟声卡」听音时用这个补上画面)。
   */
  async startScreenOnly(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false,
    });
    this.displayStream?.getVideoTracks().forEach((t) => t.stop());
    this.displayStream = stream;
    this.video?.remove();
    this.video = null;
  }

  /** 抓当前画面的一帧,返回 JPEG data URL(没有画面返回 null)。 */
  async screenshot(): Promise<string | null> {
    // 有辅助程序时直接拿它手上那一帧:不用弹共享选择器,你切到 IDE 也照样拿得到。
    if (this.helper) {
      const { port, token } = this.helper;
      const res = await fetch(`http://127.0.0.1:${port}/frame?t=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(6_000),
      }).catch(() => null);
      if (!res?.ok) return null;
      const blob = await res.blob();
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    }

    const stream = this.displayStream;
    const track = stream?.getVideoTracks().find((t) => t.readyState === "live");
    if (!stream || !track) return null;

    if (!this.video) {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([track]);
      // 挂进文档(1px 隐形):游离的 video 元素在部分浏览器里不解码,画到 canvas 会是全黑。
      video.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
      document.body.appendChild(video);
      await video.play().catch(() => {});
      this.video = video;
    }
    const video = this.video;
    // 刚 play 的一两帧可能还没解码出尺寸,等一下再拿。
    for (let i = 0; i < 20 && (!video.videoWidth || !video.videoHeight); i += 1) {
      await new Promise((r) => window.setTimeout(r, 50));
    }
    if (!video.videoWidth || !video.videoHeight) return null;

    const maxW = 1_600;
    const scale = Math.min(1, maxW / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    for (const pipeline of this.channels.values()) pipeline.stop();
    this.channels.clear();
    // 先让 pipeline 收尾最后一段,再断掉和辅助程序的连接。
    this.helperAbort?.abort();
    this.helperAbort = null;
    this.helper = null;
    this.displayStream?.getTracks().forEach((t) => t.stop());
    this.displayStream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
    // 收尾的 recorder.stop() 是异步的,等它把最后一段吐出来再关 AudioContext。
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) window.setTimeout(() => void ctx.close().catch(() => {}), 1_000);
  }
}
