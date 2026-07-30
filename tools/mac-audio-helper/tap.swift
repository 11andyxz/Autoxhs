// 系统声音采集:Core Audio 进程 tap(macOS 14.4+)。
//
// 为什么不用 ScreenCaptureKit 的音轨:SCK 的音频是搭在**屏幕采集流**上的,只要别的东西碰一下
// 屏幕采集(另一个 App 截图、Zoom 的共享预览、⌘⇧4、Xnip…),系统就会把我们的流掐掉:
//   domain=com.apple.ScreenCaptureKit.SCStreamErrorDomain code=-3821(SystemStoppedStream)
// 实测用 `screencapture -x` 截一张图就能稳定复现。每断一次丢约 1 秒音频 —— 正好赶上对方
// 提问那一句就残了。
//
// Core Audio tap 是专门抓系统音的通道,**和屏幕采集互不相干**,别人怎么截图都不影响。
// 代价是需要在「系统设置 → 隐私与安全性 → 仅系统录音」里单独放行一次(比屏幕录制更窄的权限)。
//
// 结构:全局 tap(混音后的系统输出)→ 私有聚合设备 → IOProc 拿 Float32 → 转 Int16 单声道 → audioHub。

import AVFoundation
import CoreAudio
import Foundation

/// tap 是否收到过非零样本(用来识别「权限没给 → 全静音」这种沉默失败)
var tapHeardSomething = false
var tapCallbacks = 0
var tapSilenceReported = false

final class SystemAudioTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    /// tap 实际输出的采样率(不一定是 48k,取决于当前输出设备)
    private(set) var sampleRate = Double(SAMPLE_RATE)
    private(set) var running = false

    /// 默认输出设备的 UID —— 聚合设备要挂在它上面,tap 才拿得到「正在播的声音」
    private static func defaultOutputDeviceUID() -> String? {
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        guard
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID) == noErr,
            deviceID != kAudioObjectUnknown
        else { return nil }

        var uid: CFString? = nil
        var uidSize = UInt32(MemoryLayout<CFString?>.size)
        var uidAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(deviceID, &uidAddr, 0, nil, &uidSize, &uid) == noErr,
            let uid
        else { return nil }
        return uid as String
    }

    /// tap 的音频格式(采样率/声道数)
    private func readTapFormat() -> AudioStreamBasicDescription? {
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd) == noErr else {
            return nil
        }
        return asbd
    }

    func start() throws {
        guard #available(macOS 14.4, *) else {
            throw NSError(
                domain: "autoxhs", code: 10,
                userInfo: [NSLocalizedDescriptionKey: "Core Audio tap 需要 macOS 14.4 或更新"])
        }

        // 1) 全局 tap:抓整台机器混音后的输出;mono 正好是我们要的
        //    excludeProcesses 为空 = 谁在播都抓(会议软件、浏览器都算)
        let desc = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        desc.name = "Autoxhs System Audio"
        desc.isPrivate = true  // 不出现在别的 App 的设备列表里
        desc.muteBehavior = .unmuted  // 只是旁听,不要把你自己的扬声器静音

        var status = AudioHardwareCreateProcessTap(desc, &tapID)
        guard status == noErr, tapID != kAudioObjectUnknown else {
            throw NSError(
                domain: NSOSStatusErrorDomain, code: Int(status),
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "建不了系统音 tap(OSStatus \(status))。多半是还没在「系统设置 → 隐私与安全性 → 仅系统录音」里放行 Autoxhs Helper。"
                ])
        }

        if let asbd = readTapFormat(), asbd.mSampleRate > 0 {
            sampleRate = asbd.mSampleRate
        }

        // 2) 私有聚合设备:把 tap 挂到默认输出设备上
        var subDevices: [[String: Any]] = []
        if let uid = Self.defaultOutputDeviceUID() {
            subDevices = [[kAudioSubDeviceUIDKey as String: uid]]
        }
        let aggKey: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "Autoxhs Aggregate",
            kAudioAggregateDeviceUIDKey as String: "com.adxztech.autoxhs.aggregate",
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceIsStackedKey as String: false,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceSubDeviceListKey as String: subDevices,
            kAudioAggregateDeviceTapListKey as String: [
                [kAudioSubTapUIDKey as String: desc.uuid.uuidString]
            ],
        ]
        status = AudioHardwareCreateAggregateDevice(aggKey as CFDictionary, &aggregateID)
        guard status == noErr, aggregateID != kAudioObjectUnknown else {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
            throw NSError(
                domain: NSOSStatusErrorDomain, code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "建不了聚合设备(OSStatus \(status))"])
        }

        // 3) IOProc:每次回调把 Float32 转成 Int16 单声道推给 audioHub
        status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, nil) {
            _, inInputData, _, _, _ in
            let list = UnsafeMutableAudioBufferListPointer(
                UnsafeMutablePointer(mutating: inInputData))
            // 权限没给时,macOS **照常给流、但内容全是静音**(不会报错)。所以这里主动盯:
            // 开头几秒钟如果一个非零样本都没有,就明确告诉用户去「仅系统录音」里放行。
            if !tapSilenceReported {
                if let d = list.first?.mData {
                    let n = Int(list.first!.mDataByteSize) / 4
                    let p = d.bindMemory(to: Float32.self, capacity: n)
                    for k in 0..<n where p[k] != 0 { tapHeardSomething = true; break }
                }
                tapCallbacks += 1
                // 48k/512 帧 ≈ 10.7ms 一次回调,~280 次约 3 秒
                if tapCallbacks > 280 && !tapHeardSomething {
                    tapSilenceReported = true
                    logLine(
                        """
                        [helper] ⚠️ 系统音 tap 一直收到静音 —— 几乎肯定是权限没给(macOS 在没授权时照常给流但内容为空)。
                          打开「系统设置 → 隐私与安全性 → 仅系统录音」,点 + 添加
                          tools/mac-audio-helper/Autoxhs Helper.app,然后重启辅助程序。
                        """)
                }
            }
            guard audioHub.count > 0, let first = list.first, let raw = first.mData else { return }
            let channels = max(1, Int(first.mNumberChannels))
            let frames = Int(first.mDataByteSize) / 4 / channels
            guard frames > 0 else { return }
            let src = raw.bindMemory(to: Float32.self, capacity: frames * channels)
            var out = Data(count: frames * 2)
            out.withUnsafeMutableBytes { dst in
                guard let base = dst.bindMemory(to: Int16.self).baseAddress else { return }
                for i in 0..<frames {
                    // 交错格式:多声道就取平均混成单声道
                    var sum: Float32 = 0
                    for c in 0..<channels { sum += src[i * channels + c] }
                    let v = max(-1.0, min(1.0, sum / Float32(channels)))
                    base[i] = Int16(v * 32_767.0)
                }
            }
            audioHub.push(out)
        }
        guard status == noErr, let procID else {
            stop()
            throw NSError(
                domain: NSOSStatusErrorDomain, code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "建不了 IOProc(OSStatus \(status))"])
        }

        status = AudioDeviceStart(aggregateID, procID)
        guard status == noErr else {
            stop()
            throw NSError(
                domain: NSOSStatusErrorDomain, code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "启动聚合设备失败(OSStatus \(status))"])
        }
        running = true
        logLine(
            "[helper] 系统音已接上(Core Audio tap):\(Int(sampleRate))Hz 单声道 —— 不再受屏幕采集干扰")
    }

    func stop() {
        if let procID {
            if running { AudioDeviceStop(aggregateID, procID) }
            AudioDeviceDestroyIOProcID(aggregateID, procID)
            self.procID = nil
        }
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        running = false
    }
}
