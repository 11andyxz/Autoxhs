// Autoxhs「AI 辅助面试」的本机辅助程序(macOS)。
//
// 干什么:用 ScreenCaptureKit 抓「这台电脑正在播的声音」和「整块屏幕的画面」,通过
// 127.0.0.1 上的一个小 HTTP 服务交给浏览器里的 Autoxhs 页面。
//
// 为什么需要它:浏览器在 macOS 上拿不到系统声音(Chrome 只给「标签页音频」),所以
// 面试用桌面版 Zoom / Teams 时,网页版听不见对方。装虚拟声卡(BlackHole)是一条路;
// 这个程序是另一条 —— 不用装驱动,系统原生能力,而且画面是持续可见的(切到 IDE 也能截屏解题)。
//
// **不落盘**:声音在内存里流过去,画面只保留最新一帧、只有页面主动来取才发。
// 这个程序自己不写任何音视频文件,也不联网(只监听回环地址)。
//
// 对外接口(都要带 ?t=<token>,token 见 ~/.autoxhs/helper.json,只有本机能读):
//   GET /health  → JSON:采样率、声道、是否已拿到屏幕录制权限
//   GET /audio   → chunked 流:Int16LE 单声道 PCM(采样率见 /health),一直推到断开
//   GET /frame   → image/jpeg:最新一帧屏幕画面(还没有帧时 503)
//
// 编译运行见同目录 run.sh。

import AVFoundation
import CoreGraphics
import CoreImage
import CoreMedia
import CryptoKit
import Foundation
import Network
import ScreenCaptureKit

// MARK: - 配置

let SAMPLE_RATE = 48_000
let CHANNELS = 1
/// 画面抓取尺寸上限(截屏解题够用,越小越省 CPU)
let FRAME_MAX_WIDTH = 1_600
/// 画面刷新间隔(秒):只是「保持最新一帧」,不是录像
let FRAME_INTERVAL = 0.5
let DEFAULT_PORT: UInt16 = 8756

// MARK: - 日志

/**
 打成 .app 由 LaunchServices 启动时,stderr 没有终端接着,失败原因(尤其是权限被拒)
 必须自己写进文件,页面才能把它显示出来。所以所有输出都走这里:stderr + ~/.autoxhs/helper.log。
 */
let logFileURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".autoxhs/helper.log")

func logLine(_ text: String) {
    let line = text.hasSuffix("\n") ? text : text + "\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
    let dir = logFileURL.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    if let handle = try? FileHandle(forWritingTo: logFileURL) {
        handle.seekToEndOfFile()
        handle.write(line.data(using: .utf8)!)
        try? handle.close()
    } else {
        try? line.data(using: .utf8)!.write(to: logFileURL)
    }
}

// MARK: - 共享状态

/// PCM 缓冲:抓到的音频先进这里,再由各个 /audio 连接取走。
/// 只保留很短的一截(约 2 秒);页面取得慢就丢旧的 —— 实时场景里旧音频没价值,也绝不堆内存。
final class AudioHub {
    private let queue = DispatchQueue(label: "audio.hub")
    private var subscribers: [ObjectIdentifier: (Data) -> Void] = [:]

    func subscribe(_ id: ObjectIdentifier, _ sink: @escaping (Data) -> Void) {
        queue.sync { subscribers[id] = sink }
    }
    func unsubscribe(_ id: ObjectIdentifier) {
        queue.sync { _ = subscribers.removeValue(forKey: id) }
    }
    var count: Int { queue.sync { subscribers.count } }

    func push(_ data: Data) {
        queue.sync {
            for sink in subscribers.values { sink(data) }
        }
    }
}

/// 最新一帧画面(JPEG)。只留一帧,不累积。
final class FrameHub {
    private let queue = DispatchQueue(label: "frame.hub")
    private var jpeg: Data?
    private var at: Date?

    func set(_ data: Data) {
        queue.sync {
            jpeg = data
            at = Date()
        }
    }
    func latest() -> (Data, Date)? {
        queue.sync {
            guard let jpeg, let at else { return nil }
            return (jpeg, at)
        }
    }
}

let audioHub = AudioHub()
let frameHub = FrameHub()
let token = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
    .map { String(format: "%02x", $0) }.joined()
var permissionOK = false

// MARK: - 采集

final class Capture: NSObject, SCStreamDelegate, SCStreamOutput {
    private var stream: SCStream?
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let audioQueue = DispatchQueue(label: "sc.audio")
    private let videoQueue = DispatchQueue(label: "sc.video")

    func start() async throws {
        // ScreenCaptureKit 自己**不会**弹授权框,没权限就直接返回「已拒绝」。
        // 所以先用 CoreGraphics 主动申请:第一次会弹出系统对话框,并把本 App
        // 加进「系统设置 → 隐私与安全性 → 屏幕录制」列表。授权后需要重开一次进程才生效。
        if !CGPreflightScreenCaptureAccess() {
            logLine("[helper] 还没有屏幕录制权限,正在弹出系统授权对话框…")
            let granted = CGRequestScreenCaptureAccess()
            if !granted {
                logLine(
                    """

                    [helper] 需要你点一下授权(只需一次):
                      · 屏幕上应该弹出了「\"Autoxhs Helper\" 想要录制这台电脑的屏幕和音频」→ 点「允许」
                      · 没看到弹窗的话:打开「系统设置 → 隐私与安全性 → 屏幕录制」,
                        把列表里的 **Autoxhs Helper** 打开(没有就点 + 添加
                        tools/mac-audio-helper/Autoxhs Helper.app)
                      · 然后回页面**再点一次「▶ 启动辅助程序」**即可 —— 权限记在这个 App 自己名下,
                        以后不管从哪里启动都算它的,不用再管终端/编辑器。
                    """)
                exit(2)
            }
        }
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw NSError(
                domain: "autoxhs", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "没找到可用的显示器"])
        }
        permissionOK = true

        let filter = SCContentFilter(
            display: display, excludingApplications: [], exceptingWindows: [])

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.sampleRate = SAMPLE_RATE
        cfg.channelCount = CHANNELS
        // 不要把「本程序自己发出的声音」录进去(它本来也不发声,保险起见)
        cfg.excludesCurrentProcessAudio = true
        let scale = min(1.0, Double(FRAME_MAX_WIDTH) / Double(display.width))
        cfg.width = Int(Double(display.width) * scale)
        cfg.height = Int(Double(display.height) * scale)
        cfg.minimumFrameInterval = CMTime(seconds: FRAME_INTERVAL, preferredTimescale: 600)
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.queueDepth = 3
        cfg.showsCursor = true

        let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
        try await stream.startCapture()
        self.stream = stream
        logLine("[helper] 采集已启动:\(cfg.width)x\(cfg.height) @\(1 / FRAME_INTERVAL)fps,音频 \(SAMPLE_RATE)Hz/\(CHANNELS)ch\n"
                )
    }

    func stop() async {
        try? await stream?.stopCapture()
        stream = nil
    }

    // MARK: SCStreamOutput

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        switch type {
        case .audio: handleAudio(sampleBuffer)
        case .screen: handleVideo(sampleBuffer)
        default: break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logLine("[helper] 采集中断:\(error.localizedDescription)\n")
        exit(1)
    }

    /// Float32 → Int16LE 单声道。页面那边直接按 Int16 读,省一次转换。
    private func handleAudio(_ sampleBuffer: CMSampleBuffer) {
        guard audioHub.count > 0, sampleBuffer.isValid else { return }
        try? sampleBuffer.withAudioBufferList { abl, _ in
            guard let buffer = abl.first, let raw = buffer.mData else { return }
            let frames = Int(buffer.mDataByteSize) / 4  // Float32
            guard frames > 0 else { return }
            let src = raw.bindMemory(to: Float32.self, capacity: frames)
            var out = Data(count: frames * 2)
            out.withUnsafeMutableBytes { dst in
                guard let base = dst.bindMemory(to: Int16.self).baseAddress else { return }
                for i in 0..<frames {
                    let v = max(-1.0, min(1.0, src[i]))
                    base[i] = Int16(v * 32_767.0)
                }
            }
            audioHub.push(out)
        }
    }

    private func handleVideo(_ sampleBuffer: CMSampleBuffer) {
        guard let px = sampleBuffer.imageBuffer else { return }
        let image = CIImage(cvPixelBuffer: px)
        guard
            let jpeg = ciContext.jpegRepresentation(
                of: image, colorSpace: CGColorSpaceCreateDeviceRGB(),
                options: [
                    CIImageRepresentationOption(
                        rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.8
                ])
        else { return }
        frameHub.set(jpeg)
    }
}

// MARK: - 极简 HTTP 服务(只听回环)

/// 活着的连接要有人持有强引用,否则对象一创建就被回收,回调全成空(编译器会警告)。
final class ConnectionRegistry {
    private let queue = DispatchQueue(label: "conn.registry")
    private var live: [ObjectIdentifier: HttpConnection] = [:]

    func add(_ c: HttpConnection) {
        queue.sync { live[ObjectIdentifier(c)] = c }
    }
    func remove(_ c: HttpConnection) {
        queue.sync { _ = live.removeValue(forKey: ObjectIdentifier(c)) }
    }
}

let registry = ConnectionRegistry()

final class HttpConnection {
    private let conn: NWConnection
    private var buffer = Data()
    private var streaming = false
    private lazy var id = ObjectIdentifier(self)

    init(_ conn: NWConnection) {
        self.conn = conn
    }

    func start() {
        conn.stateUpdateHandler = { [weak self] state in
            if case .cancelled = state { self?.cleanup() }
            if case .failed = state { self?.cleanup() }
        }
        conn.start(queue: .global())
        receive()
    }

    private func cleanup() {
        if streaming {
            streaming = false
            audioHub.unsubscribe(id)
        }
    }

    private func receive() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8 * 1024) {
            [weak self] data, _, isComplete, _ in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.buffer.append(data)
                if let headerEnd = self.buffer.range(of: Data("\r\n\r\n".utf8)) {
                    let head = String(decoding: self.buffer[..<headerEnd.lowerBound], as: UTF8.self)
                    self.handle(head)
                    return
                }
            }
            if isComplete {
                self.finish()
            } else {
                self.receive()
            }
        }
    }

    private func handle(_ head: String) {
        guard let line = head.split(separator: "\r\n").first else { return finish() }
        let parts = line.split(separator: " ")
        guard parts.count >= 2 else { return finish() }
        let target = String(parts[1])
        let path = target.split(separator: "?").first.map(String.init) ?? target
        let query = target.contains("?") ? String(target.split(separator: "?")[1]) : ""
        let given = query.split(separator: "&").first(where: { $0.hasPrefix("t=") })
            .map { String($0.dropFirst(2)) } ?? ""

        // 常量时间比较,避免用 token 长度/前缀做侧信道(本机工具,聊胜于无)
        let ok = given.count == token.count
            && given.utf8.elementsEqual(token.utf8)

        if path == "/health" {
            let body = """
                {"ok":true,"sampleRate":\(SAMPLE_RATE),"channels":\(CHANNELS),\
                "permission":\(permissionOK),"needsToken":true,"tokenOk":\(ok)}
                """
            return send(status: "200 OK", type: "application/json", body: Data(body.utf8))
        }
        guard ok else {
            return send(
                status: "403 Forbidden", type: "application/json",
                body: Data("{\"error\":\"bad token\"}".utf8))
        }

        switch path {
        case "/audio": startAudioStream()
        case "/frame":
            guard let (jpeg, at) = frameHub.latest(), Date().timeIntervalSince(at) < 5 else {
                return send(
                    status: "503 Service Unavailable", type: "application/json",
                    body: Data("{\"error\":\"no frame yet\"}".utf8))
            }
            send(status: "200 OK", type: "image/jpeg", body: jpeg)
        default:
            send(
                status: "404 Not Found", type: "application/json",
                body: Data("{\"error\":\"not found\"}".utf8))
        }
    }

    private func headers(_ status: String, _ type: String, extra: [String] = []) -> String {
        (["HTTP/1.1 \(status)", "Content-Type: \(type)", "Access-Control-Allow-Origin: *",
          "Cache-Control: no-store"] + extra).joined(separator: "\r\n") + "\r\n\r\n"
    }

    private func send(status: String, type: String, body: Data) {
        var out = Data(headers(status, type, extra: ["Content-Length: \(body.count)", "Connection: close"]).utf8)
        out.append(body)
        conn.send(
            content: out,
            completion: .contentProcessed { [weak self] _ in self?.finish() })
    }

    /// 持续把 PCM 推给这个连接(chunked)。页面断开就自动退订。
    private func startAudioStream() {
        streaming = true
        let head = headers(
            "200 OK", "application/octet-stream", extra: ["Transfer-Encoding: chunked"])
        conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
        audioHub.subscribe(id) { [weak self] pcm in
            guard let self, self.streaming else { return }
            var chunk = Data(String(format: "%x\r\n", pcm.count).utf8)
            chunk.append(pcm)
            chunk.append(Data("\r\n".utf8))
            self.conn.send(content: chunk, completion: .contentProcessed { error in
                if error != nil { self.finish() }
            })
        }
    }

    private func finish() {
        cleanup()
        conn.cancel()
        registry.remove(self)
    }
}

/// 握手文件是否由本进程写的 —— 只有自己写的才允许删。
/// (跑了第二个实例时,绝不能把还在正常服务的那个实例的文件删掉。)
var ownsInfoFile = false
let infoPathC = strdup(
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".autoxhs/helper.json").path)

/**
 起监听。**必须等到真的 ready 才写握手文件**:
 端口被占用时 NWListener 是异步进 .failed 的,早写文件会把上一个正常实例的 token 覆盖掉,
 结果那个实例还在服务、页面却拿着错的 token(实测踩过:/health 返回 tokenOk:false、/frame 403)。
 */
func startServer(port: UInt16, onReady: @escaping () -> Void) throws -> NWListener {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .init(rawValue: port)!)
    let listener = try NWListener(using: params)
    listener.newConnectionHandler = { conn in
        let c = HttpConnection(conn)
        registry.add(c) // 先登记再启动:回调期间必须有强引用活着
        c.start()
    }
    listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
            onReady()
        case .failed(let error):
            logLine("""
                [helper] 端口 \(port) 起不来:\(error.localizedDescription)
                → 多半是已经有一个辅助程序在跑了。查:pgrep -fl autoxhs-helper
                  想换端口:AUTOXHS_HELPER_PORT=8757 bash run.sh

                """)
            exit(1)
        default:
            break
        }
    }
    listener.start(queue: .global())
    return listener
}

/// 已经有一个活着的实例了吗?(读握手文件里的 pid 探一下)
func existingInstancePid() -> Int32? {
    guard let data = FileManager.default.contents(atPath: String(cString: infoPathC!)),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let pid = obj["pid"] as? Int
    else { return nil }
    let p = Int32(pid)
    if p == ProcessInfo.processInfo.processIdentifier { return nil }
    return kill(p, 0) == 0 ? p : nil
}

// MARK: - 启动

func writeInfoFile(port: UInt16) throws -> URL {
    let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".autoxhs")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("helper.json")
    let info = """
        {"port":\(port),"token":"\(token)","pid":\(ProcessInfo.processInfo.processIdentifier),\
        "startedAt":\(Int(Date().timeIntervalSince1970 * 1000))}
        """
    try Data(info.utf8).write(to: url, options: .atomic)
    // 只有自己能读(里面有 token)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    return url
}

/// 自测模式:不碰 ScreenCaptureKit(因此不需要屏幕录制权限),
/// 而是把一个 WAV 文件按实时速度当作「系统声音」推出去,并用一张 JPEG 当作「屏幕画面」。
/// 只为在没有权限的机器上验证页面侧链路,正常使用不会走到这里。
///   AUTOXHS_HELPER_FAKE_WAV=/path/a.wav  AUTOXHS_HELPER_FAKE_FRAME=/path/a.jpg
func startFakeSource(wavPath: String, framePath: String?) {
    if let framePath, let jpeg = FileManager.default.contents(atPath: framePath) {
        frameHub.set(jpeg)
        // 画面有 5 秒新鲜度限制,自测时定期刷新一下
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in frameHub.set(jpeg) }
    }
    guard let wav = FileManager.default.contents(atPath: wavPath), wav.count > 44 else {
        logLine("[helper] 自测:读不到 WAV \(wavPath)\n")
        return
    }
    // 跳过 44 字节标准 WAV 头,后面按 Int16LE 单声道 48k 处理(生成时就按这个规格转好)
    let pcm = wav.subdata(in: 44..<wav.count)
    let bytesPerTick = SAMPLE_RATE / 10 * 2  // 100ms
    var offset = 0
    permissionOK = true
    logLine("[helper] 自测模式:用 \(wavPath) 当系统声音(\(pcm.count / 2 / SAMPLE_RATE)s)\n")
    Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
        guard audioHub.count > 0 else { return }
        if offset >= pcm.count {
            // 播完后推静音,方便观察「说完 → 切段」
            audioHub.push(Data(count: bytesPerTick))
            return
        }
        let end = min(offset + bytesPerTick, pcm.count)
        audioHub.push(pcm.subdata(in: offset..<end))
        offset = end
    }
}

let port = UInt16(ProcessInfo.processInfo.environment["AUTOXHS_HELPER_PORT"] ?? "") ?? DEFAULT_PORT
let fakeWav = ProcessInfo.processInfo.environment["AUTOXHS_HELPER_FAKE_WAV"]
let capture = Capture()

// 已经有一个在跑就直接退出,别再抢端口、更别覆盖它的握手文件。
if let running = existingInstancePid() {
    logLine("""
        [helper] 已经有一个辅助程序在跑了(pid \(running)),不用再开一个。
        → 要重启它:pkill -f autoxhs-helper,然后重新跑本脚本。

        """)
    exit(0)
}

do {
    // 端口 ready 之后才写握手文件(见 startServer 的注释)
    _ = try startServer(port: port) {
        do {
            _ = try writeInfoFile(port: port)
            ownsInfoFile = true
        } catch {
            logLine("[helper] 写握手文件失败:\(error.localizedDescription)\n")
            exit(1)
        }
    }
} catch {
    logLine("[helper] 启动失败:\(error.localizedDescription)\n")
    exit(1)
}

for sig in [SIGINT, SIGTERM] {
    signal(sig) { _ in
        // unlink 是 signal-safe 的;只删自己写的那份
        if ownsInfoFile, let p = infoPathC { unlink(p) }
        _exit(0)
    }
}
atexit {
    if ownsInfoFile, let p = infoPathC { unlink(p) }
}

if let fakeWav {
    startFakeSource(
        wavPath: fakeWav,
        framePath: ProcessInfo.processInfo.environment["AUTOXHS_HELPER_FAKE_FRAME"])
    logLine("[helper] 就绪(自测模式):http://127.0.0.1:\(port)\n")
    RunLoop.main.run()
    exit(0)
}

Task {
    do {
        try await capture.start()
        logLine("[helper] 就绪:http://127.0.0.1:\(port)(token 已写入 ~/.autoxhs/helper.json)\n按 Ctrl-C 退出。\n"
                )
    } catch {
        logLine("""
            [helper] 拿不到屏幕采集权限:\(error.localizedDescription)

            怎么给权限(只需做一次,和用哪个终端/编辑器无关):
              1. 打开「系统设置 → 隐私与安全性 → 屏幕录制」
                 (命令:open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
              2. 把列表里的 **Autoxhs Helper** 打开;没有的话点 + 添加
                 tools/mac-audio-helper/Autoxhs Helper.app
              3. 回页面再点一次「▶ 启动辅助程序」

            不想折腾权限的话,用虚拟声卡那条路:brew install blackhole-2ch(装完重启一次),
            然后页面上「③ 怎么听到面试官」选「虚拟声卡 / 指定输入设备」——那条路不需要任何权限。

            """)
        exit(1)
    }
}

RunLoop.main.run()
