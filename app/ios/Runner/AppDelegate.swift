import AVFoundation
import Flutter
import Speech
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var voiceController: PsyberVoiceController?
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    let storageChannel = FlutterMethodChannel(
      name: "psyber/storage",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    storageChannel.setMethodCallHandler { call, result in
      if call.method == "getAppSupportDir" {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        result(dir?.path)
      } else {
        result(FlutterMethodNotImplemented)
      }
    }

    let qrChannel = FlutterMethodChannel(
      name: "psyber/qr",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    qrChannel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "scanQrCode" else {
        result(FlutterMethodNotImplemented)
        return
      }
      DispatchQueue.main.async {
        self?.presentQrScanner(result: result)
      }
    }

    let voiceChannel = FlutterMethodChannel(
      name: "psyber/voice",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    let voiceCtrl = PsyberVoiceController(channel: voiceChannel)
    voiceChannel.setMethodCallHandler { [weak voiceCtrl] call, result in
      voiceCtrl?.handle(call, result: result)
    }
    self.voiceController = voiceCtrl
  }

  private func presentQrScanner(result: @escaping FlutterResult) {
    guard let rootVc = topViewController() else {
      result(nil)
      return
    }
    let scanner = PsyberQrScannerViewController { scanned in
      result(scanned)
    }
    scanner.modalPresentationStyle = .fullScreen
    rootVc.present(scanner, animated: true)
  }

  private func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let keyWindow = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
    var top = keyWindow?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}

/// 轻量原生 AVFoundation 二维码扫描视图控制器（零第三方插件）。
private final class PsyberQrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let onComplete: (String?) -> Void
  private let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "psyber.qr.session")
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var cameraReady = false
  private var finished = false
  private var callbackInvoked = false

  init(onComplete: @escaping (String?) -> Void) {
    self.onComplete = onComplete
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    setupCamera()
    setupOverlay()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    // 等转场动画完全结束后再启动取景扫描，避免 present 动画进行中识别到二维码导致 UIKit 丢弃 dismiss
    guard cameraReady, !finished else { return }
    sessionQueue.async { [weak self] in
      guard let self = self, !self.finished, !self.session.isRunning else { return }
      self.session.startRunning()
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.bounds
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    stopSessionAsync()
  }

  private func setupCamera() {
    guard let device = AVCaptureDevice.default(for: .video),
          let input = try? AVCaptureDeviceInput(device: device),
          session.canAddInput(input) else {
      DispatchQueue.main.async { [weak self] in
        self?.finish(with: nil)
      }
      return
    }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else {
      DispatchQueue.main.async { [weak self] in
        self?.finish(with: nil)
      }
      return
    }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
    output.metadataObjectTypes = [.qr]

    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    preview.frame = view.bounds
    view.layer.addSublayer(preview)
    previewLayer = preview
    cameraReady = true
  }

  private func setupOverlay() {
    let cancelButton = UIButton(type: .system)
    cancelButton.setTitle("取消", for: .normal)
    cancelButton.setTitleColor(.white, for: .normal)
    cancelButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .medium)
    cancelButton.backgroundColor = UIColor.black.withAlphaComponent(0.5)
    cancelButton.layer.cornerRadius = 18
    cancelButton.contentEdgeInsets = UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)
    cancelButton.translatesAutoresizingMaskIntoConstraints = false
    cancelButton.addTarget(self, action: #selector(handleCancel), for: .touchUpInside)
    view.addSubview(cancelButton)

    let hintLabel = UILabel()
    hintLabel.text = "对准终端或桌面端设置页中的 Psyber 配对二维码"
    hintLabel.textColor = .white
    hintLabel.font = .systemFont(ofSize: 14, weight: .regular)
    hintLabel.textAlignment = .center
    hintLabel.numberOfLines = 0
    hintLabel.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(hintLabel)

    NSLayoutConstraint.activate([
      cancelButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
      cancelButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
      hintLabel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -36),
      hintLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      hintLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
    ])
  }

  @objc private func handleCancel() {
    finish(with: nil)
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !finished,
          let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
          obj.type == .qr,
          let value = obj.stringValue,
          !value.isEmpty else {
      return
    }
    finish(with: value)
  }

  private func stopSessionAsync() {
    sessionQueue.async { [weak self] in
      guard let self = self, self.session.isRunning else { return }
      self.session.stopRunning()
    }
  }

  private func invokeCallbackOnce(_ value: String?) {
    guard !callbackInvoked else { return }
    callbackInvoked = true
    onComplete(value)
  }

  private func finish(with value: String?) {
    let wasFinished = finished
    finished = true
    if !wasFinished && value != nil {
      UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
    stopSessionAsync()

    let performDismiss = { [weak self] in
      guard let self = self else { return }
      if self.presentingViewController != nil {
        self.dismiss(animated: true) {
          self.invokeCallbackOnce(value)
        }
      } else {
        self.invokeCallbackOnce(value)
      }
    }

    // 若仍处于弹出转场动画中，等转场收尾后再执行 dismiss，确保相机页不会残留
    if let coordinator = transitionCoordinator {
      coordinator.animate(alongsideTransition: nil) { _ in
        performDismiss()
      }
    } else if isBeingPresented {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        performDismiss()
      }
    } else {
      performDismiss()
    }
  }
}

/// 原生 Apple AVAudioEngine + SFSpeechRecognizer 语音条录制/实时识别与回放控制器（零第三方插件）。
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
    let micGranted = AVAudioSession.sharedInstance().recordPermission == .granted
    let speechGranted = SFSpeechRecognizer.authorizationStatus() == .authorized
    return ["mic": micGranted, "speech": speechGranted]
  }

  private func requestPermissions(result: @escaping FlutterResult) {
    AVAudioSession.sharedInstance().requestRecordPermission { micGranted in
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

    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
      )
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      result(FlutterError(code: "AUDIO_SESSION_ERROR", message: "无法启动麦克风音频会话：\(error.localizedDescription)", details: nil))
      return
    }

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
    if #available(iOS 16.0, *) {
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
            // 长停顿或达到单次识别上限时无缝续接，避免打断用户口语思考
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
    // 关闭 AVAudioFile 句柄确保 AAC moov 头完整落盘
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
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .default, options: [])
      try session.setActive(true)
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
