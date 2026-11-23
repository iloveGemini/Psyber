import AVFoundation
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
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
