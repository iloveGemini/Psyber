import AVFoundation
import Cocoa
import FlutterMacOS
import Speech
import UserNotifications

class MainFlutterWindow: NSWindow, NSDraggingDestination, UNUserNotificationCenterDelegate {
  private var desktopMediaChannel: FlutterMethodChannel?
  private var localNotificationsChannel: FlutterMethodChannel?
  private var voiceController: PsyberVoiceController?

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    var windowFrame = self.frame
    let didResizeDefault = windowFrame.width < 900 || windowFrame.height < 640
    if didResizeDefault {
      windowFrame.size = NSSize(width: 980, height: 700)
    }
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)
    if didResizeDefault {
      self.center()
    }

    RegisterGeneratedPlugins(registry: flutterViewController)

    let channel = FlutterMethodChannel(
      name: "psyber/desktop_media",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handleDesktopMediaCall(call, result: result)
    }
    self.desktopMediaChannel = channel
    self.registerForDraggedTypes([.fileURL])

    let notifyChannel = FlutterMethodChannel(
      name: "psyber/local_notifications",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    notifyChannel.setMethodCallHandler { [weak self] call, result in
      self?.handleLocalNotificationsCall(call, result: result)
    }
    self.localNotificationsChannel = notifyChannel
    UNUserNotificationCenter.current().delegate = self

    let voiceChannel = FlutterMethodChannel(
      name: "psyber/voice",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    let voiceCtrl = PsyberVoiceController(channel: voiceChannel)
    voiceChannel.setMethodCallHandler { [weak voiceCtrl] call, result in
      voiceCtrl?.handle(call, result: result)
    }
    self.voiceController = voiceCtrl

    super.awakeFromNib()
    self.title = "Psyber"
    self.titleVisibility = .hidden
    self.titlebarAppearsTransparent = true
    self.styleMask.insert(.fullSizeContentView)
    self.minSize = NSSize(width: 420, height: 560)
  }

  private func handleDesktopMediaCall(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "readClipboardMedia":
      result(readClipboardMedia())
    case "extractVideoFrames":
      guard let args = call.arguments as? [String: Any],
            let path = args["path"] as? String else {
        result(nil)
        return
      }
      let maxFrames = (args["maxFrames"] as? Int) ?? 4
      extractVideoFrames(path: path, maxFrames: maxFrames, result: result)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func readClipboardMedia() -> [String: Any]? {
    let pb = NSPasteboard.general
    if let urls = pb.readObjects(forClasses: [NSURL.self], options: [
      .urlReadingFileURLsOnly: true
    ]) as? [URL], !urls.isEmpty {
      let paths = urls.map { $0.path }
      if !paths.isEmpty {
        return ["filePaths": paths]
      }
    }
    if let pngData = pb.data(forType: .png) {
      return [
        "bytes": FlutterStandardTypedData(bytes: pngData),
        "filename": "clipboard.png",
        "mimeType": "image/png",
      ]
    }
    if let tiffData = pb.data(forType: .tiff),
       let bitmap = NSBitmapImageRep(data: tiffData),
       let pngData = bitmap.representation(using: .png, properties: [:]) {
      return [
        "bytes": FlutterStandardTypedData(bytes: pngData),
        "filename": "clipboard.png",
        "mimeType": "image/png",
      ]
    }
    return nil
  }

  private func extractVideoFrames(path: String, maxFrames: Int, result: @escaping FlutterResult) {
    DispatchQueue.global(qos: .userInitiated).async {
      let url = URL(fileURLWithPath: path)
      let asset = AVURLAsset(url: url)
      let durationSec = CMTimeGetSeconds(asset.duration)
      guard durationSec.isFinite, durationSec > 0 else {
        DispatchQueue.main.async { result(nil) }
        return
      }

      let generator = AVAssetImageGenerator(asset: asset)
      generator.appliesPreferredTrackTransform = true
      generator.maximumSize = CGSize(width: 960, height: 960)
      generator.requestedTimeToleranceBefore = CMTime(seconds: 0.25, preferredTimescale: 600)
      generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)

      let count = max(1, min(maxFrames, 6))
      var frames: [FlutterStandardTypedData] = []
      for i in 0..<count {
        let ratio = (Double(i) + 0.5) / Double(count)
        let t = CMTime(seconds: durationSec * ratio, preferredTimescale: 600)
        if let cgImage = try? generator.copyCGImage(at: t, actualTime: nil) {
          let rep = NSBitmapImageRep(cgImage: cgImage)
          if let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.78]) {
            frames.append(FlutterStandardTypedData(bytes: jpeg))
          }
        }
      }

      DispatchQueue.main.async {
        if frames.isEmpty {
          result(nil)
        } else {
          result([
            "durationSec": durationSec,
            "frames": frames,
          ])
        }
      }
    }
  }

  func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    if hasSupportedDraggedFiles(sender) {
      desktopMediaChannel?.invokeMethod("onDragStateChanged", arguments: true)
      return .copy
    }
    return []
  }

  func draggingExited(_ sender: NSDraggingInfo?) {
    desktopMediaChannel?.invokeMethod("onDragStateChanged", arguments: false)
  }

  func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    desktopMediaChannel?.invokeMethod("onDragStateChanged", arguments: false)
    let urls = readDraggedFileUrls(sender)
    if urls.isEmpty { return false }
    desktopMediaChannel?.invokeMethod("onFilesDropped", arguments: urls.map { $0.path })
    return true
  }

  private func readDraggedFileUrls(_ sender: NSDraggingInfo) -> [URL] {
    let pb = sender.draggingPasteboard
    return (pb.readObjects(forClasses: [NSURL.self], options: [
      .urlReadingFileURLsOnly: true
    ]) as? [URL]) ?? []
  }

  private func hasSupportedDraggedFiles(_ sender: NSDraggingInfo) -> Bool {
    return !readDraggedFileUrls(sender).isEmpty
  }

  private func handleLocalNotificationsCall(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let center = UNUserNotificationCenter.current()
    switch call.method {
    case "requestPermission":
      center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
        DispatchQueue.main.async { result(granted) }
      }
    case "showNotification":
      guard let args = call.arguments as? [String: Any],
            let title = args["title"] as? String,
            let body = args["body"] as? String else {
        result(nil)
        return
      }
      let identifier = (args["id"] as? String) ?? UUID().uuidString
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.sound = .default
      let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
      center.add(request) { _ in
        DispatchQueue.main.async { result(nil) }
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if #available(macOS 11.0, *) {
      completionHandler([.banner, .sound])
    } else {
      completionHandler([.alert, .sound])
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    DispatchQueue.main.async {
      NSApp.activate(ignoringOtherApps: true)
      self.makeKeyAndOrderFront(nil)
      completionHandler()
    }
  }
}

/// macOS 原生 AVAudioEngine + SFSpeechRecognizer 语音条录制/实时识别与回放控制器（零第三方插件）。
private final class PsyberVoiceController: NSObject, AVAudioPlayerDelegate {
  private let channel: FlutterMethodChannel
  private let stateLock = NSLock()

  private var audioEngine: AVAudioEngine?
  private var audioFile: AVAudioFile?
  private var tempAudioUrl: URL?
  private var speechRecognizer: SFSpeechRecognizer?
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?

  private var isRecording = false
  private var recordingStartedAt: Date?
  private var lastUpdateEmitAt: TimeInterval = 0
  private var committedTranscript = ""
  private var currentSegmentTranscript = ""
  private var activeLocaleId: String?
  private var recognitionGeneration: Int = 0
  private var pendingStopFinalCallback: (() -> Void)?

  private var audioPlayer: AVAudioPlayer?
  private var playingAudioId: String?
  private var playbackTimer: Timer?
  private var downloadTask: URLSessionDataTask?

  init(channel: FlutterMethodChannel) {
    self.channel = channel
    super.init()
  }

  func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "checkPermission":
      result(currentPermissionDict())
    case "requestPermission":
      requestPermissions(result: result)
    case "startRecording":
      let args = call.arguments as? [String: Any]
      let locale = args?["locale"] as? String
      startRecording(localeIdentifier: locale, result: result)
    case "switchLocale":
      let args = call.arguments as? [String: Any]
      let locale = args?["locale"] as? String
      switchLocale(localeIdentifier: locale)
      result(true)
    case "stopRecording":
      stopRecording(result: result)
    case "cancelRecording":
      cancelRecording()
      result(true)
    case "playAudio":
      guard let args = call.arguments as? [String: Any],
            let id = args["id"] as? String,
            let urlStr = args["url"] as? String else {
        result(FlutterError(code: "INVALID_ARGS", message: "缺少音频播放参数", details: nil))
        return
      }
      let token = (args["token"] as? String) ?? ""
      playAudio(id: id, urlString: urlStr, token: token, result: result)
    case "stopAudio":
      stopPlayback(notify: true)
      result(true)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func currentPermissionDict() -> [String: Any] {
    let micGranted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    let speechGranted = SFSpeechRecognizer.authorizationStatus() == .authorized
    return ["mic": micGranted, "speech": speechGranted]
  }

  private func requestPermissions(result: @escaping FlutterResult) {
    AVCaptureDevice.requestAccess(for: .audio) { micGranted in
      DispatchQueue.main.async {
        SFSpeechRecognizer.requestAuthorization { speechStatus in
          DispatchQueue.main.async {
            result([
              "mic": micGranted,
              "speech": speechStatus == .authorized,
            ])
          }
        }
      }
    }
  }

  private func buildFullTranscriptLocked() -> String {
    let a = committedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    let b = currentSegmentTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    if a.isEmpty { return b }
    if b.isEmpty { return a }
    return a + " " + b
  }

  private func startRecording(localeIdentifier: String?, result: @escaping FlutterResult) {
    stopPlayback(notify: true)
    cancelRecording()

    // 每次录音按需新建 AVAudioEngine，避免在首次麦克风授权前初始化的旧引擎引发 CoreAudio 异常
    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let hwFormat = inputNode.inputFormat(forBus: 0)
    guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
      result(FlutterError(code: "NO_AUDIO_INPUT", message: "未检测到可用麦克风输入", details: nil))
      return
    }

    let fileUrl = FileManager.default.temporaryDirectory
      .appendingPathComponent("psyber_voice_\(UUID().uuidString).m4a")

    stateLock.lock()
    audioEngine = engine
    audioFile = nil
    tempAudioUrl = fileUrl
    isRecording = true
    recordingStartedAt = Date()
    lastUpdateEmitAt = 0
    committedTranscript = ""
    currentSegmentTranscript = ""
    activeLocaleId = localeIdentifier
    pendingStopFinalCallback = nil
    stateLock.unlock()

    if SFSpeechRecognizer.authorizationStatus() == .authorized {
      startSpeechRecognitionSegment(localeIdentifier: localeIdentifier)
    }

    inputNode.removeTap(onBus: 0)
    // format 传 nil 让引擎按当前硬件实际格式回调，并在首帧按真实格式延迟建文件，避免首次授权或蓝牙切采样率崩溃
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
      self?.handleAudioBuffer(buffer)
    }

    engine.prepare()
    do {
      try engine.start()
      result(true)
    } catch {
      cancelRecording()
      result(FlutterError(code: "ENGINE_ERROR", message: "无法启动录音引擎：\(error.localizedDescription)", details: nil))
    }
  }

  private func switchLocale(localeIdentifier: String?) {
    guard SFSpeechRecognizer.authorizationStatus() == .authorized else { return }
    stateLock.lock()
    guard isRecording else {
      stateLock.unlock()
      return
    }
    let seg = currentSegmentTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    if !seg.isEmpty {
      committedTranscript = committedTranscript.isEmpty ? seg : (committedTranscript + " " + seg)
    }
    currentSegmentTranscript = ""
    activeLocaleId = localeIdentifier
    recognitionGeneration += 1
    let oldReq = recognitionRequest
    let oldTask = recognitionTask
    recognitionRequest = nil
    recognitionTask = nil
    stateLock.unlock()

    oldReq?.endAudio()
    oldTask?.cancel()
    startSpeechRecognitionSegment(localeIdentifier: localeIdentifier)
  }

  private func startSpeechRecognitionSegment(localeIdentifier: String?) {
    let preferredLocale: Locale
    if let id = localeIdentifier, !id.isEmpty {
      preferredLocale = Locale(identifier: id)
    } else {
      preferredLocale = Locale(identifier: "zh-CN")
    }
    var recognizer = SFSpeechRecognizer(locale: preferredLocale)
    if recognizer == nil || !(recognizer?.isAvailable ?? false) {
      recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    }
    if recognizer == nil || !(recognizer?.isAvailable ?? false) {
      recognizer = SFSpeechRecognizer(locale: Locale.current)
    }
    guard let activeRecognizer = recognizer, activeRecognizer.isAvailable else { return }

    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if #available(macOS 13.0, *) {
      req.addsPunctuation = true
    }

    stateLock.lock()
    recognitionGeneration += 1
    let gen = recognitionGeneration
    speechRecognizer = activeRecognizer
    recognitionRequest = req
    stateLock.unlock()

    let task = activeRecognizer.recognitionTask(with: req) { [weak self] speechResult, error in
      guard let self = self else { return }
      var shouldRestart = false
      var stopCallback: (() -> Void)?
      var transcriptToEmit: String?
      var durationSec: Double = 0

      self.stateLock.lock()
      guard self.recognitionGeneration == gen else {
        self.stateLock.unlock()
        return
      }
      if let sr = speechResult {
        self.currentSegmentTranscript = sr.bestTranscription.formattedString
        transcriptToEmit = self.buildFullTranscriptLocked()
        if let started = self.recordingStartedAt {
          durationSec = Date().timeIntervalSince(started)
        }
        if sr.isFinal {
          if self.isRecording {
            let seg = self.currentSegmentTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
            if !seg.isEmpty {
              self.committedTranscript = self.committedTranscript.isEmpty
                ? seg
                : (self.committedTranscript + " " + seg)
            }
            self.currentSegmentTranscript = ""
            shouldRestart = true
          } else {
            stopCallback = self.pendingStopFinalCallback
            self.pendingStopFinalCallback = nil
          }
        }
      } else if error != nil {
        if !self.isRecording {
          stopCallback = self.pendingStopFinalCallback
          self.pendingStopFinalCallback = nil
        }
      }
      let localeId = self.activeLocaleId
      self.stateLock.unlock()

      if let t = transcriptToEmit {
        DispatchQueue.main.async {
          self.channel.invokeMethod("onVoiceUpdate", arguments: [
            "transcript": t,
            "durationSec": durationSec,
          ])
        }
      }
      if let cb = stopCallback {
        DispatchQueue.main.async { cb() }
      } else if shouldRestart {
        DispatchQueue.main.async {
          self.startSpeechRecognitionSegment(localeIdentifier: localeId)
        }
      }
    }

    stateLock.lock()
    recognitionTask = task
    stateLock.unlock()
  }

  private func handleAudioBuffer(_ buffer: AVAudioPCMBuffer) {
    stateLock.lock()
    let recording = isRecording
    let req = recognitionRequest
    var file = audioFile
    let fileUrl = tempAudioUrl
    let started = recordingStartedAt
    let prevEmit = lastUpdateEmitAt
    let now = Date().timeIntervalSinceReferenceDate
    let shouldEmit = (now - prevEmit) >= 0.06
    if shouldEmit { lastUpdateEmitAt = now }
    let transcript = shouldEmit ? buildFullTranscriptLocked() : nil
    if recording, file == nil, let url = fileUrl {
      let fmt = buffer.format
      if fmt.sampleRate > 0, fmt.channelCount > 0 {
        let aacSettings: [String: Any] = [
          AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
          AVSampleRateKey: fmt.sampleRate,
          AVNumberOfChannelsKey: Int(min(max(1, fmt.channelCount), 2)),
          AVEncoderBitRateKey: 64_000,
        ]
        if let created = try? AVAudioFile(
          forWriting: url,
          settings: aacSettings,
          commonFormat: fmt.commonFormat,
          interleaved: fmt.isInterleaved
        ) {
          audioFile = created
          file = created
        }
      }
    }
    stateLock.unlock()

    guard recording else { return }
    req?.append(buffer)
    if let outFile = file {
      try? outFile.write(from: buffer)
    }
    if shouldEmit, let t = transcript {
      let level = computeNormalizedLevel(buffer)
      let durationSec = started != nil ? Date().timeIntervalSince(started!) : 0.0
      DispatchQueue.main.async {
        self.channel.invokeMethod("onVoiceUpdate", arguments: [
          "transcript": t,
          "level": level,
          "durationSec": durationSec,
        ])
      }
    }
  }

  private func computeNormalizedLevel(_ buffer: AVAudioPCMBuffer) -> Double {
    guard let channelData = buffer.floatChannelData?[0] else { return 0.0 }
    let count = Int(buffer.frameLength)
    if count <= 0 { return 0.0 }
    var sum: Float = 0
    for i in 0..<count {
      let sample = channelData[i]
      sum += sample * sample
    }
    let rms = sqrt(sum / Float(count))
    let db = 20 * log10(max(rms, 0.00001))
    let normalized = (db + 52.0) / 46.0
    return Double(min(max(normalized, 0.0), 1.0))
  }

  private func stopRecording(result: @escaping FlutterResult) {
    stateLock.lock()
    guard isRecording else {
      stateLock.unlock()
      result(nil)
      return
    }
    isRecording = false
    let started = recordingStartedAt
    let fileUrl = tempAudioUrl
    let req = recognitionRequest
    let hasSpeechTask = recognitionTask != nil
    let engine = audioEngine
    audioEngine = nil
    audioFile = nil
    stateLock.unlock()

    if let eng = engine {
      eng.inputNode.removeTap(onBus: 0)
      if eng.isRunning {
        eng.stop()
      }
      eng.reset()
    }
    req?.endAudio()

    let durationSec = started != nil ? max(0.1, Date().timeIntervalSince(started!)) : 0.0
    var finalized = false
    let finishStop: () -> Void = { [weak self] in
      guard let self = self, !finalized else { return }
      finalized = true
      self.stateLock.lock()
      let transcript = self.buildFullTranscriptLocked()
      self.recognitionTask?.cancel()
      self.recognitionTask = nil
      self.recognitionRequest = nil
      self.pendingStopFinalCallback = nil
      self.tempAudioUrl = nil
      self.stateLock.unlock()

      var audioBytes = Data()
      if let url = fileUrl {
        audioBytes = (try? Data(contentsOf: url)) ?? Data()
        try? FileManager.default.removeItem(at: url)
      }
      result([
        "bytes": FlutterStandardTypedData(bytes: audioBytes),
        "durationSec": durationSec,
        "transcript": transcript,
        "mimeType": "audio/mp4",
      ])
    }

    if hasSpeechTask {
      stateLock.lock()
      pendingStopFinalCallback = finishStop
      stateLock.unlock()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
        finishStop()
      }
    } else {
      finishStop()
    }
  }

  private func cancelRecording() {
    stateLock.lock()
    isRecording = false
    let fileUrl = tempAudioUrl
    let engine = audioEngine
    audioEngine = nil
    audioFile = nil
    tempAudioUrl = nil
    recognitionGeneration += 1
    recognitionRequest?.endAudio()
    recognitionTask?.cancel()
    recognitionTask = nil
    recognitionRequest = nil
    pendingStopFinalCallback = nil
    committedTranscript = ""
    currentSegmentTranscript = ""
    stateLock.unlock()

    if let eng = engine {
      eng.inputNode.removeTap(onBus: 0)
      if eng.isRunning {
        eng.stop()
      }
      eng.reset()
    }
    if let url = fileUrl {
      try? FileManager.default.removeItem(at: url)
    }
  }

  private func playAudio(id: String, urlString: String, token: String, result: @escaping FlutterResult) {
    stopPlayback(notify: true)
    let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
      .appendingPathComponent("psyber_voice", isDirectory: true)
    try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    let safeId = id.replacingOccurrences(of: "/", with: "_")
    let localFile = cacheDir.appendingPathComponent("\(safeId).m4a")

    if FileManager.default.fileExists(atPath: localFile.path) {
      startAudioPlayer(id: id, fileUrl: localFile, result: result)
      return
    }

    guard let remoteUrl = URL(string: urlString) else {
      result(FlutterError(code: "INVALID_URL", message: "音频地址无效", details: nil))
      return
    }
    var request = URLRequest(url: remoteUrl)
    if !token.isEmpty {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    downloadTask = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      DispatchQueue.main.async {
        guard let self = self else { return }
        if let error = error {
          result(FlutterError(code: "DOWNLOAD_ERROR", message: error.localizedDescription, details: nil))
          return
        }
        guard let data = data, !data.isEmpty else {
          result(FlutterError(code: "EMPTY_AUDIO", message: "音频内容为空", details: nil))
          return
        }
        do {
          try data.write(to: localFile, options: .atomic)
          self.startAudioPlayer(id: id, fileUrl: localFile, result: result)
        } catch {
          result(FlutterError(code: "CACHE_ERROR", message: error.localizedDescription, details: nil))
        }
      }
    }
    downloadTask?.resume()
  }

  private func startAudioPlayer(id: String, fileUrl: URL, result: @escaping FlutterResult) {
    do {
      let player = try AVAudioPlayer(contentsOf: fileUrl)
      player.delegate = self
      player.prepareToPlay()
      player.play()
      audioPlayer = player
      playingAudioId = id
      emitPlaybackState(id: id, playing: true, position: 0, duration: player.duration)
      playbackTimer?.invalidate()
      playbackTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
        guard let self = self, let p = self.audioPlayer, let pid = self.playingAudioId else { return }
        self.emitPlaybackState(id: pid, playing: p.isPlaying, position: p.currentTime, duration: p.duration)
      }
      result(true)
    } catch {
      result(FlutterError(code: "PLAYBACK_ERROR", message: error.localizedDescription, details: nil))
    }
  }

  private func stopPlayback(notify: Bool) {
    downloadTask?.cancel()
    downloadTask = nil
    playbackTimer?.invalidate()
    playbackTimer = nil
    let prevId = playingAudioId
    let prevDuration = audioPlayer?.duration ?? 0
    audioPlayer?.stop()
    audioPlayer = nil
    playingAudioId = nil
    if notify, let pid = prevId {
      emitPlaybackState(id: pid, playing: false, position: 0, duration: prevDuration)
    }
  }

  private func emitPlaybackState(id: String, playing: Bool, position: Double, duration: Double) {
    channel.invokeMethod("onPlaybackState", arguments: [
      "id": id,
      "playing": playing,
      "positionSec": position,
      "durationSec": duration,
    ])
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    DispatchQueue.main.async { [weak self] in
      self?.stopPlayback(notify: true)
    }
  }
}
